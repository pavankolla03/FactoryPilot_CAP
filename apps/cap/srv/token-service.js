const cds = require('@sap/cds')
const quota = require('./lib/quota')

const rolesOf = (req) => Object.keys(req.user?.roles || {}).filter((r) => !r.startsWith('$'))

module.exports = cds.service.impl(function () {
  this.on('checkAndReserve', async (req) => {
    const subject = req.data.subject || req.user.id
    // A user may only spend their own quota. Without this check any caller
    // with InsightsQuery could reserve against someone else's budget.
    if (subject !== req.user.id && !req.user.is('TokenMaintain')) {
      return req.reject(403, 'Cannot reserve quota for another user')
    }
    const decision = await quota.checkAndReserve(subject, rolesOf(req), req.data.estimatedTokens || 1)
    return {
      decision: decision.decision,
      exceededWindow: decision.exceededWindow || null,
      reserved: decision.reserved || 0,
      retryAfterEpoch: decision.retryAfterEpoch || null,
      remainingDay: decision.remainingDay ?? null,
      remainingWeek: decision.remainingWeek ?? null,
      remainingMonth: decision.remainingMonth ?? null,
    }
  })

  this.on('reconcile', async (req) => {
    const subject = req.data.subject || req.user.id
    if (subject !== req.user.id && !req.user.is('TokenMaintain')) {
      return req.reject(403, 'Cannot reconcile quota for another user')
    }
    return await quota.reconcile(subject, rolesOf(req), req.data.reserved, req.data.actualTokens)
  })

  this.on('myUsage', async (req) => await quota.snapshot(req.user.id, rolesOf(req)))

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'QuotaPolicies', (req) => {
    const d = req.data
    for (const [field, value] of Object.entries({
      dailyLimit: d.dailyLimit,
      weeklyLimit: d.weeklyLimit,
      monthlyLimit: d.monthlyLimit,
    })) {
      if (value != null && value < 0) req.error(400, `${field} cannot be negative`, field)
    }
    // A weekly cap below the daily one is almost always a typo, and it makes
    // the daily limit unreachable — worth catching at entry, not in support.
    if (d.dailyLimit != null && d.weeklyLimit != null && d.weeklyLimit < d.dailyLimit) {
      req.error(400, 'weeklyLimit is lower than dailyLimit — the daily limit could never be reached', 'weeklyLimit')
    }
    if (d.weeklyLimit != null && d.monthlyLimit != null && d.monthlyLimit < d.weeklyLimit) {
      req.error(400, 'monthlyLimit is lower than weeklyLimit', 'monthlyLimit')
    }
  })

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'ApiKeyRefs', (req) => {
    const ref = req.data.credentialRef
    if (ref && /[^A-Z0-9_]/.test(ref)) {
      req.error(400, 'credentialRef must be an env var name, never the key itself', 'credentialRef')
    }
  })
})
