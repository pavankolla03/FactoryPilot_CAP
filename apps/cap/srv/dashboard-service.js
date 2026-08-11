const cds = require('@sap/cds')
const quota = require('./lib/quota')

const pct = (part, whole) => (whole ? Math.round((part / whole) * 10000) / 100 : 0)
const today = () => new Date().toISOString().slice(0, 10)

module.exports = cds.service.impl(function () {
  this.on('overview', async () => {
    const { SessionLog, PendingAction } = cds.entities('factorypilot.audit')
    const { BusinessObjectConfig } = cds.entities('factorypilot.config')

    const logs = await SELECT.from(SessionLog)
    const day = today()
    const todays = logs.filter((l) => String(l.timestamp || '').slice(0, 10) === day)

    const looks = logs.filter((l) => l.cacheResult === 'HIT' || l.cacheResult === 'MISS')
    const hits = looks.filter((l) => l.cacheResult === 'HIT').length

    // Grounding is measured over answered requests only. Counting denials and
    // failures in the denominator would make a healthy system look ungrounded
    // simply because someone hit their quota.
    const answered = logs.filter((l) => l.status === 'SUCCESS')
    const grounded = answered.filter((l) => l.grounded === true).length

    const timed = logs.filter((l) => (l.totalResponseTimeMs || 0) > 0)
    const avgMs = timed.length
      ? Math.round(timed.reduce((n, l) => n + l.totalResponseTimeMs, 0) / timed.length)
      : 0

    const [pending, activeObjects] = await Promise.all([
      SELECT.from(PendingAction).where({ status: 'PENDING' }),
      SELECT.from(BusinessObjectConfig).where({ isActive: true }),
    ])

    return {
      requestsToday: todays.length,
      requestsTotal: logs.length,
      tokensToday: todays.reduce((n, l) => n + (l.tokensUsed || 0), 0),
      tokensTotal: logs.reduce((n, l) => n + (l.tokensUsed || 0), 0),
      cacheHitRatio: pct(hits, looks.length),
      groundedRatio: pct(grounded, answered.length),
      quotaDenials: logs.filter((l) => l.quotaResult === 'DENIED').length,
      failures: logs.filter((l) => l.status === 'FAILED').length,
      pendingApprovals: pending.length,
      avgResponseMs: avgMs,
      activeUsers: new Set(logs.map((l) => l.userID).filter(Boolean)).size,
      activeObjects: activeObjects.length,
    }
  })

  this.on('quotaHeadroom', async () => {
    const { Consumption, QuotaPolicy } = cds.entities('factorypilot.token')
    const start = quota.periodStart('DAY').toISOString().slice(0, 10)

    const [rows, policies] = await Promise.all([
      SELECT.from(Consumption).where({ periodType: 'DAY', periodStart: start }),
      SELECT.from(QuotaPolicy).where({ isActive: true }),
    ])
    const bySubject = new Map(policies.map((p) => [p.subject, p]))
    const fallback = bySubject.get('DEFAULT')

    return rows
      .map((row) => {
        const policy = bySubject.get(row.userID) || fallback
        const limit = policy?.dailyLimit ?? null
        const used = row.consumedCount || 0
        const percent = limit ? pct(used, limit) : 0
        return {
          userID: row.userID,
          limitType: policy?.limitType || null,
          usedDay: used,
          limitDay: limit,
          percentUsed: percent,
          // 80% is the point at which someone is worth warning rather than
          // discovering they were blocked mid-shift.
          atRisk: limit != null && percent >= 80,
        }
      })
      .sort((a, b) => b.percentUsed - a.percentUsed)
  })
})
