const cds = require('@sap/cds')

const WINDOWS = ['DAY', 'WEEK', 'MONTH']

/** Start of the window a moment falls in. Weeks start Monday. */
function periodStart(window, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (window === 'DAY') return d
  if (window === 'WEEK') {
    const dow = (d.getDay() + 6) % 7 // Monday = 0
    d.setDate(d.getDate() - dow)
    return d
  }
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function periodEnd(window, now = new Date()) {
  const start = periodStart(window, now)
  if (window === 'DAY') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  if (window === 'WEEK') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
  return new Date(start.getFullYear(), start.getMonth() + 1, 1)
}

const iso = (d) => d.toISOString().slice(0, 10)

/**
 * Resolve the policy that applies: the user's own row wins, then any role row,
 * then DEFAULT. Anything more clever here makes limits hard to reason about
 * when someone asks why they were blocked.
 */
async function resolvePolicy(subject, roles = []) {
  const { QuotaPolicy } = cds.entities('factorypilot.token')
  const candidates = [subject, ...roles, 'DEFAULT']
  const rows = await SELECT.from(QuotaPolicy).where({ isActive: true, subject: { in: candidates } })
  const bySubject = new Map(rows.map((r) => [r.subject, r]))
  for (const key of candidates) if (bySubject.has(key)) return bySubject.get(key)
  return null
}

function limitFor(policy, window) {
  return { DAY: policy.dailyLimit, WEEK: policy.weeklyLimit, MONTH: policy.monthlyLimit }[window]
}

/** `tx` is optional: without it the query runs on the ambient request
 *  transaction. Opening a fresh one here and never committing it is what
 *  deadlocks SQLite. */
async function readCounter(subject, window, start, tx = null) {
  const { Consumption } = cds.entities('factorypilot.token')
  const q = SELECT.one.from(Consumption).where({ userID: subject, periodType: window, periodStart: iso(start) })
  return (await (tx ? tx.run(q) : q)) || null
}

/**
 * Check every window and reserve in one transaction.
 *
 * Reserve-then-verify: the counter is incremented first and rolled back if it
 * broke a limit. Checking first and incrementing after leaves a window where
 * two concurrent requests both see room under the same cap.
 */
async function checkAndReserve(subject, roles, estimatedTokens, now = new Date()) {
  const policy = await resolvePolicy(subject, roles)
  if (!policy) {
    // No policy at all, not even DEFAULT. Allow, but record that no limit was
    // in force rather than inventing one.
    return { decision: 'ALLOWED', reserved: 0, remainingDay: null, remainingWeek: null, remainingMonth: null }
  }

  const cost = policy.limitType === 'TOKEN_COUNT' ? Math.max(1, estimatedTokens || 1) : 1
  const { Consumption } = cds.entities('factorypilot.token')

  // Increment first, verify second, and compensate by hand if a window was
  // breached.
  //
  // Reading first and writing after leaves a gap in which two concurrent
  // requests both see room under the same cap. Rollback is not available to us
  // either: this runs inside CAP's ambient request transaction, and opening a
  // nested one to roll back independently deadlocks on SQLite's write lock. So
  // the compensation is explicit.
  const applied = []
  const remaining = {}

  for (const window of WINDOWS) {
    const limit = limitFor(policy, window)
    if (limit == null) continue

    const start = periodStart(window, now)
    const existing = await readCounter(subject, window, start)

    if (existing) {
      await UPDATE(Consumption)
        .set({ consumedCount: { '+=': cost }, requestCount: { '+=': 1 }, lastUpdated: now })
        .where({ ID: existing.ID })
    } else {
      await INSERT.into(Consumption).entries({
        ID: cds.utils.uuid(),
        userID: subject,
        periodType: window,
        periodStart: iso(start),
        consumedCount: cost,
        requestCount: 1,
        lastUpdated: now,
      })
    }
    applied.push(window)

    const after = await readCounter(subject, window, start)
    const used = after?.consumedCount || 0

    if (used > limit) {
      await compensate(subject, applied, cost, now)
      return {
        decision: 'DENIED',
        exceededWindow: window,
        reserved: 0,
        retryAfterEpoch: Math.floor(periodEnd(window, now).getTime() / 1000),
        policy,
      }
    }
    remaining[window] = limit - used
  }

  return {
    decision: 'ALLOWED',
    reserved: cost,
    remainingDay: remaining.DAY ?? null,
    remainingWeek: remaining.WEEK ?? null,
    remainingMonth: remaining.MONTH ?? null,
    policy,
  }
}

/** Give back every increment this call made, including windows that passed
 *  before the one that failed. */
async function compensate(subject, windows, cost, now) {
  const { Consumption } = cds.entities('factorypilot.token')
  for (const window of windows) {
    const row = await readCounter(subject, window, periodStart(window, now))
    if (!row) continue
    await UPDATE(Consumption)
      .set({
        consumedCount: Math.max(0, (row.consumedCount || 0) - cost),
        requestCount: Math.max(0, (row.requestCount || 0) - 1),
        lastUpdated: now,
      })
      .where({ ID: row.ID })
  }
}

/**
 * Settle the estimate against real usage.
 *
 * Matters in both directions: an over-reservation that is never refunded eats
 * quota the user did not spend, and a failed call must give back everything it
 * reserved.
 */
async function reconcile(subject, roles, reserved, actualTokens, now = new Date()) {
  const policy = await resolvePolicy(subject, roles)
  if (!policy || policy.limitType !== 'TOKEN_COUNT') return false

  const delta = (actualTokens || 0) - (reserved || 0)
  if (delta === 0) return false

  const { Consumption } = cds.entities('factorypilot.token')
  for (const window of WINDOWS) {
    if (limitFor(policy, window) == null) continue
    const start = periodStart(window, now)
    const existing = await readCounter(subject, window, start)
    if (!existing) continue
    await UPDATE(Consumption)
      .set({ consumedCount: Math.max(0, (existing.consumedCount || 0) + delta), lastUpdated: now })
      .where({ ID: existing.ID })
  }
  return true
}

async function snapshot(subject, roles, now = new Date()) {
  const policy = await resolvePolicy(subject, roles)
  const used = {}
  for (const window of WINDOWS) {
    const row = await readCounter(subject, window, periodStart(window, now))
    used[window] = row?.consumedCount || 0
  }
  return {
    userID: subject,
    limitType: policy?.limitType || null,
    usedDay: used.DAY,
    usedWeek: used.WEEK,
    usedMonth: used.MONTH,
    limitDay: policy ? policy.dailyLimit : null,
    limitWeek: policy ? policy.weeklyLimit : null,
    limitMonth: policy ? policy.monthlyLimit : null,
  }
}

module.exports = { WINDOWS, periodStart, periodEnd, resolvePolicy, checkAndReserve, reconcile, snapshot }
