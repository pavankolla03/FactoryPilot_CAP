/**
 * Watchers — a question asked once and answered forever. (BETA)
 *
 * "Tell me if stock of P123 drops below 500" is the same question as one
 * someone types into the chat, except nobody has to remember to type it. That
 * is most of the distance between a tool you open and a system that works on
 * your behalf.
 *
 * The design turns on one thing: **alert on the edge, not on the state.**
 *
 * A watcher is evaluated on a schedule, so a condition that is true stays true
 * at the next sweep, and the one after that. Notifying each time produces an
 * alert every few minutes for a situation the recipient already knows about,
 * which gets muted within a day — and a muted alert is worse than none,
 * because everyone still believes it is working. So an alert fires when the
 * condition *becomes* true, and not again until it has cleared and returned.
 *
 * Reads go through the same tools the agent uses. A watcher that disagreed
 * with what the chat says about the same data would make both untrustworthy.
 */

const cds = require('@sap/cds')
const tools = require('./tools')

const log = cds.log('watchers')

const EVAL_TIMEOUT_MS = Number(process.env.FACTORYPILOT_WATCHER_EVAL_MS || 20_000)

const COMPARISONS = {
  LT:  (a, b) => a < b,
  LTE: (a, b) => a <= b,
  GT:  (a, b) => a > b,
  GTE: (a, b) => a >= b,
  EQ:  (a, b) => a === b,
  NE:  (a, b) => a !== b,
}

const COMPARISON_WORDS = {
  LT: 'below', LTE: 'at or below', GT: 'above', GTE: 'at or above',
  EQ: 'equal to', NE: 'not equal to',
}

/**
 * Reduce the rows a watcher read to the single number it is about.
 *
 * ROW_COUNT is the default because it covers most of what people actually ask
 * for — "tell me when there are open counts" — and needs no field name, which
 * is the part someone configuring a watcher is most likely to get wrong.
 */
function measure(watcher, rows) {
  if (watcher.measure === 'ROW_COUNT' || !watcher.measure) return rows.length

  const field = watcher.fieldName
  if (!field) throw new Error(`measure ${watcher.measure} needs a field name`)

  const numbers = rows
    .map((r) => Number(r[field]))
    .filter((n) => Number.isFinite(n))

  // No usable values is not zero. Returning 0 would read as "stock is zero"
  // and fire a below-threshold alert for a field that was simply misspelt.
  if (!numbers.length) throw new Error(`no numeric values found in field "${field}"`)

  switch (watcher.measure) {
    case 'FIELD_MIN': return Math.min(...numbers)
    case 'FIELD_MAX': return Math.max(...numbers)
    case 'FIELD_SUM': return numbers.reduce((a, b) => a + b, 0)
    default: throw new Error(`unknown measure "${watcher.measure}"`)
  }
}

/** Read a watcher's data and reduce it to a value. Throws on a real failure. */
async function evaluate(watcher, businessObjects, correlationId) {
  const bo = businessObjects.find((b) => b.objectCode === watcher.objectCode)
  if (!bo) throw new Error(`business object ${watcher.objectCode} is not registered or not active`)

  const args = {}
  if (watcher.warehouseID) args.warehouse = watcher.warehouseID
  if (watcher.filterText) args.filter = watcher.filterText

  const result = await tools.executeRead(
    tools.toolNameFor(watcher.objectCode), args,
    {
      businessObjects,
      defaults: { warehouse: watcher.warehouseID || '' },
      correlationId,
      timeoutMs: EVAL_TIMEOUT_MS,
    }
  )
  return measure(watcher, result.rows || [])
}

/** The sentence a person reads. Says the number, the rule, and where. */
function describe(watcher, value) {
  const what = watcher.measure === 'ROW_COUNT' || !watcher.measure
    ? `${value} row${value === 1 ? '' : 's'}`
    : `${watcher.fieldName} ${watcher.measure.replace('FIELD_', '').toLowerCase()} is ${value}`
  const rule = `${COMPARISON_WORDS[watcher.comparison] || watcher.comparison} ${watcher.threshold}`
  const where = watcher.warehouseID ? ` in plant ${watcher.warehouseID}` : ''
  return `${watcher.name}: ${what}${where} — ${rule}.`
}

/**
 * Sweep every active watcher once.
 *
 * Returns what happened rather than notifying directly, so the caller decides
 * delivery and this stays testable without a webhook.
 */
async function sweep({ correlationId = `watch-${Date.now()}` } = {}) {
  const { Watcher } = cds.entities('factorypilot.jobs')
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')

  const watchers = await SELECT.from(Watcher).where({ isActive: true })
  if (!watchers.length) return { checked: 0, alerts: [], cleared: [], errors: [] }

  const businessObjects = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
  const alerts = []
  const cleared = []
  const errors = []
  const now = new Date()

  for (const w of watchers) {
    let value
    try {
      value = await evaluate(w, businessObjects, correlationId)
    } catch (err) {
      // A watcher that cannot be read is recorded and skipped. It must not be
      // treated as "not breached" — that would silently clear a real alert the
      // moment the source system went down, which is exactly when it matters.
      errors.push({ name: w.name, error: err.message })
      await UPDATE(Watcher).set({ lastCheckedAt: now, lastError: err.message.slice(0, 300) }).where({ ID: w.ID })
      log.warn(`watcher "${w.name}" could not be evaluated: ${err.message}`)
      continue
    }

    const compare = COMPARISONS[w.comparison] || COMPARISONS.LT
    const breached = compare(Number(value), Number(w.threshold))
    const wasBreached = Boolean(w.lastBreached)
    const patch = {
      lastCheckedAt: now,
      lastValue: value,
      lastBreached: breached,
      lastError: null,
    }

    // The edge, not the state.
    if (breached && !wasBreached) {
      patch.lastAlertedAt = now
      patch.alertCount = (Number(w.alertCount) || 0) + 1
      alerts.push({ name: w.name, value, text: describe(w, value), owner: w.owner })
    } else if (!breached && wasBreached) {
      cleared.push({ name: w.name, value, text: `${w.name}: back to normal (${value}).` })
    }

    await UPDATE(Watcher).set(patch).where({ ID: w.ID })
  }

  return { checked: watchers.length, alerts, cleared, errors }
}

/** Render a sweep into the message a person receives. */
function render(result) {
  const lines = ['[BETA]', '']
  for (const a of result.alerts) lines.push(`⚠  ${a.text}`)
  for (const c of result.cleared) lines.push(`✓  ${c.text}`)
  if (result.errors.length) {
    lines.push('')
    for (const e of result.errors) lines.push(`?  ${e.name}: could not be checked — ${e.error}`)
    lines.push('A watcher that cannot be read is not the same as one that is fine.')
  }
  return lines.join('\n')
}

module.exports = { sweep, evaluate, measure, describe, render, COMPARISONS }
