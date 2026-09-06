const cds = require('@sap/cds')

const prefs = require('./lib/prefs')
const policy = require('./lib/policy')
const confighealth = require('./lib/confighealth')

module.exports = cds.service.impl(function () {
  /**
   * Remember one preference for the caller. (BETA)
   *
   * `req.user.id` decides whose preference this is — never a parameter. A
   * userID parameter would let anyone set anyone else's default plant, which
   * silently redirects their questions to a site they do not work at.
   */
  this.on('setPreference', async (req) => {
    const { prefKey, prefValue } = req.data
    try {
      const r = await prefs.set(req.user.id, prefKey, prefValue)
      return {
        ...r,
        message: r.cleared ? `Forgot ${prefKey}.` : `Will remember ${prefKey} = ${r.prefValue}.`,
      }
    } catch (err) {
      if (err.code === 'INVALID_PREFERENCE') return req.reject(400, err.message)
      throw err
    }
  })

  this.on('myPreferences', async (req) => {
    const stored = await prefs.forUser(req.user.id)
    return Object.entries(stored).map(([prefKey, prefValue]) => ({
      prefKey, prefValue, cleared: false,
      message: prefs.PREFERENCE_KEYS[prefKey]?.description || '',
    }))
  })

  this.on('configHealth', () => confighealth.checks())

  this.on('probeConnections', async () => {
    // A probe that throws tells the operator nothing about which backend was
    // at fault, and this is the screen they opened *because* something is
    // wrong. Every per-backend failure is already a row; only a failure of the
    // probe itself reaches here.
    try {
      return await confighealth.probe()
    } catch (err) {
      return [{ name: 'Probe', kind: 'probe', status: 'error', detail: err.message, elapsedMs: 0 }]
    }
  })

  this.on('effectivePolicy', async (req) => {
    const { userID, warehouseID } = req.data
    return await policy.effectivePolicy(userID || req.user.id, warehouseID)
  })

  this.on('canWrite', async (req) => {
    const { userID, warehouseID } = req.data
    return await policy.canWrite(userID || req.user.id, warehouseID)
  })

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'UserScopes', (req) => {
    const level = req.data.accessLevel
    if (level && !['read', 'write'].includes(level)) {
      req.error(400, "accessLevel must be 'read' or 'write'", 'accessLevel')
    }
  })

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'ApprovalPolicies', (req) => {
    const { scopeKind, subject, writeCeiling } = req.data
    if (scopeKind && !['USER', 'WAREHOUSE', 'ORG'].includes(scopeKind)) {
      req.error(400, "scopeKind must be USER, WAREHOUSE or ORG", 'scopeKind')
    }
    if (scopeKind && scopeKind !== 'ORG' && !subject) {
      req.error(400, `A ${scopeKind} policy needs a subject to apply to`, 'subject')
    }
    if (writeCeiling != null && writeCeiling < 0) req.error(400, 'writeCeiling cannot be negative', 'writeCeiling')
  })

  // Removing the last admin locks everyone out of configuration, and the only
  // way back is a database edit. Refuse it here.
  this.before(['UPDATE', 'DELETE'], 'Users', async (req) => {
    const { User } = cds.entities('factorypilot.admin')
    const id = req.params[0]?.ID ?? req.params[0]
    const target = await SELECT.one.from(User).where({ ID: id })
    if (!target?.isAdmin) return

    const losingAdmin = req.event === 'DELETE' || req.data.isAdmin === false || req.data.isActive === false
    if (!losingAdmin) return

    const others = await SELECT.one`count(*) as n`.from(User).where({ isAdmin: true, isActive: true, ID: { '!=': id } })
    if (!others?.n) req.error(400, 'This is the last active administrator — promote another user first')
  })
})
