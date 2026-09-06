/**
 * Questions that are allowed to take minutes. (BETA)
 *
 * `ASK_BUDGET_MS` bounds every synchronous question at about 75 seconds,
 * because a browser is waiting and the gateway gives up at two. That is right
 * for a chat box and wrong for the questions Tier 2 made possible: a root-cause
 * chain across a month of movements is legitimately slow, and the honest answer
 * to one today is "that took longer than I am allowed to spend".
 *
 * So the work moves off the request. Nothing about *how* the question is
 * answered changes — same agent, same tools, same quota, same audit — only how
 * long it may take and who is waiting for it.
 *
 * Two things this deliberately does not do:
 *
 * **It does not re-implement the agent.** The worker calls `agent.run` exactly
 * as the request path does. A second implementation would be a second place for
 * grounding, approval and audit to be true, and therefore a second place for
 * them to stop being true — the same reasoning as `confirmBatch`.
 *
 * **It does not execute writes.** `agent.run` already stops at a write and
 * returns a proposal; an async run records that proposal and nothing more.
 * Nobody is watching a background job, so it is the last place that should be
 * allowed to change a real system unattended.
 */

const cds = require('@sap/cds')

const agent = require('./agent')
const quota = require('./quota')

const log = cds.log('async')

/**
 * How long an async question may take.
 *
 * Generous, because the whole point is to escape the request ceiling — but
 * still finite. A run that cannot finish in ten minutes has almost certainly
 * hit something wrong rather than something slow, and leaving it going would
 * hold a scheduler lease and burn quota for an answer nobody will read.
 */
const ASYNC_BUDGET_MS = Number(process.env.FACTORYPILOT_ASYNC_BUDGET_MS || 10 * 60_000)

/** Runs older than this that never finished are declared dead. */
const STALE_AFTER_MS = Number(process.env.FACTORYPILOT_ASYNC_STALE_MS || 30 * 60_000)

/** How many queued questions one sweep will take. */
const BATCH = Number(process.env.FACTORYPILOT_ASYNC_BATCH || 3)

/**
 * Queue a question.
 *
 * Quota is reserved here rather than in the worker: the person submitting
 * should be told immediately that they are out of allowance, not fifteen
 * minutes later by a background job they cannot see.
 */
async function submit({ userID, roles, question, warehouseID, conversationID }) {
  const { AsyncRun } = cds.entities('factorypilot.jobs')

  // The reservation is a *gate*, not an accounting entry: it stops somebody
  // with no allowance left from queueing work, and reconciliation at the end
  // records what was actually spent. So it is deliberately modest.
  //
  // Reserving against what an async question might really cost (8000+) looked
  // more honest and was worse: QuotaPolicy carries a `perRequestMaxTokens`
  // sized for chat — 4000 by default — so a larger estimate was refused at
  // submit and no async question could ever be queued under a default policy.
  // A deployment that wants long async work should raise that limit rather
  // than have this pretend the question will be small.
  const estimate = Number(process.env.FACTORYPILOT_ASYNC_TOKEN_ESTIMATE || 2000)
  const reservation = await quota.checkAndReserve(userID, roles || [], estimate)
  // `decision`, not `allowed`. Reading a field the reservation does not carry
  // made every value falsy, so every async question was refused for quota —
  // by a caller that had plenty. The failure looked exactly like a real quota
  // denial, which is what made it worth a test rather than a glance.
  if (reservation.decision !== 'ALLOWED') {
    const err = new Error(
      `Quota exceeded${reservation.exceededWindow ? ` for the ${reservation.exceededWindow.toLowerCase()}` : ''}.`)
    err.code = 'QUOTA_EXCEEDED'
    err.retryAfterEpoch = reservation.retryAfterEpoch
    throw err
  }

  const ID = cds.utils.uuid()
  await INSERT.into(AsyncRun).entries({
    ID,
    userID,
    conversationID: conversationID || null,
    question,
    warehouseID: warehouseID || null,
    status: 'QUEUED',
    progress: 'Queued — waiting for a worker.',
    queuedAt: new Date(),
    correlationId: `async-${ID.slice(0, 8)}`,
    quotaReserved: reservation.reserved || 0,
  })
  log.info(`queued async question ${ID} for ${userID}`)
  return { runID: ID, status: 'QUEUED' }
}

/** Claim one queued run. Conditional so two workers cannot take the same one. */
async function claim(runID) {
  const { AsyncRun } = cds.entities('factorypilot.jobs')
  const affected = await UPDATE(AsyncRun)
    .set({ status: 'RUNNING', startedAt: new Date(), progress: 'Working on it.' })
    .where`ID = ${runID} and status = 'QUEUED'`
  return affected === 1
}

/** Run one question to completion and record what happened. */
async function execute(run) {
  const { AsyncRun } = cds.entities('factorypilot.jobs')
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const { OrgSettings } = cds.entities('factorypilot.admin')

  if (!(await claim(run.ID))) return null   // another worker has it

  const startedAt = Date.now()
  try {
    const businessObjects = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
    const orgSettings = await SELECT.one.from(OrgSettings)

    const result = await agent.run({
      question: run.question,
      userID: run.userID,
      roles: [],
      warehouseID: run.warehouseID,
      conversationID: run.conversationID,
      correlationId: run.correlationId,
      businessObjects,
      route: {},
      orgSettings,
      deadlineAt: startedAt + ASYNC_BUDGET_MS,
    })

    // A proposed write is recorded as the answer and goes no further. Nobody
    // is watching a background job, so it is the last place that should change
    // a real system unattended.
    const answer = result.status === 'AWAITING_APPROVAL'
      ? `${result.answer || ''}\n\nThis question proposes a change. It has NOT been made — ` +
        'open the conversation to review and confirm it.'
      : result.answer

    await UPDATE(AsyncRun).set({
      status: result.status === 'FAILED' ? 'FAILED' : 'SUCCESS',
      progress: null,
      answer: (answer || '').slice(0, 20000),
      grounded: Boolean(result.grounded),
      rounds: result.rounds || 0,
      tokensUsed: result.usage?.totalTokens || 0,
      errorDetail: result.errorDetail ? String(result.errorDetail).slice(0, 2000) : null,
      finishedAt: new Date(),
    }).where({ ID: run.ID })

    // Reconcile against what was reserved, exactly as the request path does.
    await quota.reconcile(run.userID, [], run.quotaReserved || 0, result.usage?.totalTokens || 0)
      .catch((err) => log.warn(`could not reconcile quota for ${run.ID}: ${err.message}`))

    return { runID: run.ID, status: result.status, tokens: result.usage?.totalTokens || 0 }
  } catch (err) {
    await UPDATE(AsyncRun).set({
      status: 'FAILED',
      progress: null,
      errorDetail: String(err && err.stack ? err.stack : err).slice(0, 2000),
      answer: 'This question could not be completed. The detail is on the run.',
      finishedAt: new Date(),
    }).where({ ID: run.ID })
    await quota.reconcile(run.userID, [], run.quotaReserved || 0, 0).catch(() => {})
    log.error(`async run ${run.ID} failed:`, err)
    return { runID: run.ID, status: 'FAILED' }
  }
}

/**
 * Take up to `BATCH` queued questions, and bury anything that died mid-flight.
 *
 * A run left RUNNING is a worker that was killed — a container recycled, a
 * deploy landing. It cannot be resumed, because the agent keeps no
 * intermediate state, so it is marked EXPIRED and its quota given back. Leaving
 * it RUNNING forever would show the submitter a spinner that never resolves.
 */
async function sweep() {
  const { AsyncRun } = cds.entities('factorypilot.jobs')

  const stale = await SELECT.from(AsyncRun)
    .where({ status: 'RUNNING', startedAt: { '<': new Date(Date.now() - STALE_AFTER_MS) } })
  for (const s of stale) {
    await UPDATE(AsyncRun).set({
      status: 'EXPIRED',
      progress: null,
      errorDetail: 'The worker running this stopped before it finished — most likely the instance was recycled.',
      answer: 'This question was interrupted and did not complete. Please ask it again.',
      finishedAt: new Date(),
    }).where({ ID: s.ID })
    await quota.reconcile(s.userID, [], s.quotaReserved || 0, 0).catch(() => {})
    log.warn(`async run ${s.ID} expired — it was left RUNNING since ${s.startedAt}`)
  }

  const queued = await SELECT.from(AsyncRun).where({ status: 'QUEUED' }).orderBy('queuedAt').limit(BATCH)
  const done = []
  for (const run of queued) {
    const outcome = await execute(run)
    if (outcome) done.push(outcome)
  }

  return { taken: done.length, expired: stale.length, outcomes: done }
}

module.exports = { submit, execute, sweep, claim, ASYNC_BUDGET_MS, STALE_AFTER_MS, BATCH }
