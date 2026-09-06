/**
 * Per-user preferences. (BETA)
 *
 * "I look after plant 1710" should not need saying twice — but *remembering
 * what someone said* and *remembering a preference* are different features
 * with very different risks, and this is deliberately the second one.
 *
 * Free-text memory injected into a system prompt is two problems at once:
 *
 * It is a prompt-injection surface. Anything a user can store, they can use to
 * instruct the model — including instructing it to disregard the rules above
 * it. The system prompt is where grounding, write-refusal and plant-scoping
 * live, and user-authored text sitting next to those has to be assumed
 * hostile, not merely untidy.
 *
 * And it is a correctness risk. A sentence remembered in March reaches the
 * model in September carrying the same confidence as a figure read from SAP,
 * with nothing attached to say it has expired.
 *
 * So: an allowlisted key set, a validator per key, and values that flow through
 * paths that already existed — `defaultPlant` becomes `defaults.warehouse`, the
 * same field the plant dropdown fills. Nothing here ever becomes a sentence in
 * a prompt. A preference cannot express anything the schema does not already
 * permit, which is exactly the property that makes it safe to remember.
 */

const cds = require('@sap/cds')

const log = cds.log('prefs')

/**
 * Every preference that may be stored, and what counts as a valid value.
 *
 * Adding a key is a deliberate act. That is the point: the set is small, each
 * entry has a reason, and a key outside it is refused rather than stored and
 * silently ignored — which would look like it worked.
 */
const PREFERENCE_KEYS = {
  defaultPlant: {
    description: 'Plant used when a question names none. Overrides the org default; a plant chosen in the UI still wins.',
    // Plant codes in S/4 are short alphanumerics. Anything else is a mistake
    // or an attempt to smuggle something through.
    validate: (v) => (/^[A-Za-z0-9]{1,8}$/.test(v) ? null : 'A plant code is up to 8 letters or digits.'),
  },
  preferredView: {
    description: 'Whether answers open as a table or a chart when either would do.',
    validate: (v) => (['table', 'chart'].includes(v) ? null : "Must be 'table' or 'chart'."),
  },
  defaultDateWindow: {
    description: 'The period a question means when it names none.',
    validate: (v) =>
      ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_week', 'last_week', 'this_month', 'last_month']
        .includes(v) ? null : 'Not one of the supported date presets.',
  },
}

/** Check a key and value. Returns an error string, or null when acceptable. */
function validate(prefKey, prefValue) {
  const spec = PREFERENCE_KEYS[prefKey]
  if (!spec) {
    return `"${prefKey}" is not a preference this system stores. ` +
      `Known preferences: ${Object.keys(PREFERENCE_KEYS).join(', ')}.`
  }
  if (prefValue === null || prefValue === undefined || prefValue === '') return null   // clearing is allowed
  return spec.validate(String(prefValue))
}

/** Everything remembered for one person, as a plain object. */
async function forUser(userID) {
  if (!userID) return {}
  try {
    const { UserPreference } = cds.entities('factorypilot.admin')
    const rows = await SELECT.from(UserPreference).where({ userID })
    const out = {}
    for (const r of rows) {
      // Defensive: a key removed from the allowlist after rows were written
      // must stop being honoured, not linger because it is in the table.
      if (PREFERENCE_KEYS[r.prefKey] && r.prefValue) out[r.prefKey] = r.prefValue
    }
    return out
  } catch (err) {
    // A preference is a convenience. Failing to read one must never stop a
    // question being answered.
    log.warn(`could not read preferences for ${userID}: ${err.message}`)
    return {}
  }
}

/** Store or clear one preference. Upsert, because a preference is singular. */
async function set(userID, prefKey, prefValue) {
  const error = validate(prefKey, prefValue)
  if (error) throw Object.assign(new Error(error), { code: 'INVALID_PREFERENCE' })

  const { UserPreference } = cds.entities('factorypilot.admin')
  const existing = await SELECT.one.from(UserPreference).where({ userID, prefKey })

  if (prefValue === null || prefValue === undefined || prefValue === '') {
    if (existing) await DELETE.from(UserPreference).where({ ID: existing.ID })
    return { prefKey, prefValue: null, cleared: true }
  }
  if (existing) {
    await UPDATE(UserPreference).set({ prefValue: String(prefValue) }).where({ ID: existing.ID })
  } else {
    await INSERT.into(UserPreference).entries({
      ID: cds.utils.uuid(), userID, prefKey, prefValue: String(prefValue),
    })
  }
  return { prefKey, prefValue: String(prefValue), cleared: false }
}

/**
 * Which plant a question is about.
 *
 * Most specific wins: what the user picked now, then what they told us once,
 * then what the organisation defaults to. A preference is a standing answer to
 * a question nobody asked this time — it must never override a choice made
 * this time.
 */
function resolveWarehouse({ requested, preferences = {}, orgDefault } = {}) {
  return requested || preferences.defaultPlant || orgDefault || ''
}

module.exports = { PREFERENCE_KEYS, validate, forUser, set, resolveWarehouse }
