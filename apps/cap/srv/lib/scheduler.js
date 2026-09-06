/**
 * Background jobs, run exactly once across every instance. (BETA)
 *
 * The product has until now been entirely reactive: a person asks, it answers.
 * This is the piece that lets it act on its own — and the reason it is more
 * than a `setInterval` is that Cloud Foundry runs several copies of the same
 * application. A plain timer fires in all of them, so a daily digest would be
 * delivered three times and a threshold alert would page someone in triplicate.
 *
 * So a job is claimed with a *lease* held in the database:
 *
 *   UPDATE ScheduledJob SET lockedUntil = now + lease
 *    WHERE jobName = ? AND (lockedUntil IS NULL OR lockedUntil < now)
 *
 * The database decides the winner, because it is the only thing all instances
 * share. Exactly one UPDATE reports a row changed; every other instance sees
 * zero and moves on. A lease rather than a boolean because an instance that
 * dies mid-run cannot clear a flag — with a lease it simply stops renewing and
 * the job becomes claimable again once it expires.
 *
 * Failure is contained deliberately: a job that throws is recorded and the
 * scheduler keeps going. Background work must never be able to take down the
 * request path that people are actually using.
 */

const cds = require('@sap/cds')
const os = require('node:os')

const log = cds.log('scheduler')

/** How often to look for due work. Not how often jobs run — that is per job. */
const TICK_MS = Number(process.env.FACTORYPILOT_SCHEDULER_TICK_MS || 60_000)

/**
 * How long a claim is held.
 *
 * Long enough that a slow job is not stolen from underneath itself, short
 * enough that a container killed mid-run does not strand the job until
 * tomorrow. Renewed while a job is running, so a job legitimately longer than
 * this keeps its claim as long as it is alive.
 */
const LEASE_MS = Number(process.env.FACTORYPILOT_SCHEDULER_LEASE_MS || 5 * 60_000)
const RENEW_MS = Math.floor(LEASE_MS / 2)

/** Names this instance in the log and in JobRun. Never used for decisions. */
const INSTANCE =
  process.env.CF_INSTANCE_GUID ||
  `${os.hostname()}:${process.pid}`

const handlers = new Map()
let timer = null
let running = false

/**
 * Register what a job actually does.
 *
 * A handler returns a short summary string, which is what lands in JobRun and
 * is the thing an operator reads when asking "did it do anything last night?".
 */
function register(jobName, handler) {
  if (typeof handler !== 'function') throw new TypeError(`handler for ${jobName} must be a function`)
  handlers.set(jobName, handler)
}

/**
 * Is this job due?
 *
 * Two shapes, because two shapes is all anything here needs. `runAtHour` is a
 * daily job — due when the local hour matches and it has not already run today.
 * Otherwise it is an interval job, due once `intervalMinutes` have passed.
 *
 * Local hour, not UTC: "the 6am digest" means six in the morning where the
 * operator is, and a warehouse supervisor does not care what UTC thinks.
 */
function isDue(job, now = new Date()) {
  const last = job.lastRunAt ? new Date(job.lastRunAt) : null

  if (job.runAtHour !== null && job.runAtHour !== undefined) {
    if (now.getHours() !== job.runAtHour) return false
    if (!last) return true
    return (
      last.getFullYear() !== now.getFullYear() ||
      last.getMonth() !== now.getMonth() ||
      last.getDate() !== now.getDate()
    )
  }

  if (!last) return true
  const every = Math.max(1, Number(job.intervalMinutes) || 60)
  return now.getTime() - last.getTime() >= every * 60_000
}

/**
 * Try to claim a job. Returns true only for the instance that won.
 *
 * The whole guarantee rests on this UPDATE being conditional: the WHERE clause
 * is evaluated by the database under its own row lock, so of N instances
 * issuing it simultaneously exactly one changes a row. Reading first and then
 * writing would race — two instances would both read an expired lease and both
 * believe they had won.
 */
async function claim(jobName, now = new Date()) {
  const { ScheduledJob } = cds.entities('factorypilot.jobs')
  const until = new Date(now.getTime() + LEASE_MS)
  // Tagged template, not an object predicate: the object form's `or` array
  // flattened into `jobName = ? or ? lockedUntil is NULL and ?` — syntactically
  // accepted, semantically nonsense, and it would have let every instance
  // claim the job. Written out, the parenthesisation is explicit and checked.
  const affected = await UPDATE(ScheduledJob)
    .set({ lockedBy: INSTANCE, lockedUntil: until })
    .where`jobName = ${jobName} and (lockedUntil is null or lockedUntil < ${now})`
  return affected === 1
}

/** Keep a claim alive while the job is still working. */
async function renew(jobName) {
  const { ScheduledJob } = cds.entities('factorypilot.jobs')
  await UPDATE(ScheduledJob)
    .set({ lockedUntil: new Date(Date.now() + LEASE_MS) })
    .where({ jobName, lockedBy: INSTANCE })
}

/** Give the claim back immediately, so a fast job is not blocked for a lease. */
async function release(jobName, outcome) {
  const { ScheduledJob } = cds.entities('factorypilot.jobs')
  await UPDATE(ScheduledJob).set({ lockedUntil: null, lockedBy: null, ...outcome }).where({ jobName })
}

/**
 * Run one job under its claim, recording what happened either way.
 *
 * A JobRun row is written for failures as much as successes — a job that has
 * been silently throwing every night for a week should be visible as seven
 * failures, not as an absence of evidence.
 */
async function runJob(job) {
  const { JobRun } = cds.entities('factorypilot.jobs')
  const handler = handlers.get(job.jobName)
  if (!handler) {
    log.warn(`no handler registered for job ${job.jobName} — skipping`)
    return
  }
  if (!(await claim(job.jobName))) return   // another instance has it

  const startedAt = new Date()
  const keepAlive = setInterval(() => renew(job.jobName).catch(() => {}), RENEW_MS)
  keepAlive.unref?.()

  let status = 'SUCCESS'
  let summary = ''
  let errorDetail = null
  try {
    log.info(`running ${job.jobName} on ${INSTANCE}`)
    summary = String((await handler({ job, instance: INSTANCE })) ?? 'done')
  } catch (err) {
    status = 'FAILED'
    errorDetail = String(err && err.stack ? err.stack : err).slice(0, 2000)
    summary = `failed: ${err && err.message ? err.message : err}`
    log.error(`job ${job.jobName} failed:`, err)
  } finally {
    clearInterval(keepAlive)
  }

  const finishedAt = new Date()
  const durationMs = finishedAt - startedAt

  try {
    await INSERT.into(JobRun).entries({
      jobName: job.jobName,
      startedAt, finishedAt, durationMs, status,
      instance: INSTANCE,
      summary: summary.slice(0, 1000),
      errorDetail,
    })
    await release(job.jobName, {
      lastRunAt: startedAt,
      lastRunStatus: status,
      lastRunMessage: summary.slice(0, 500),
      lastRunMs: durationMs,
      failureCount: status === 'FAILED' ? (Number(job.failureCount) || 0) + 1 : 0,
    })
  } catch (err) {
    // Recording the outcome failed. The lease will expire on its own, so the
    // job is not stranded — but say so, because an unrecorded run is the one
    // case where the audit trail lies by omission.
    log.error(`could not record the outcome of ${job.jobName}:`, err)
  }
  log.info(`${job.jobName} ${status.toLowerCase()} in ${durationMs}ms — ${summary.slice(0, 120)}`)
}

/** One pass over every active job. */
async function tick() {
  if (running) return          // a slow tick must not overlap itself
  running = true
  try {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    const jobs = await SELECT.from(ScheduledJob).where({ isActive: true })
    const now = new Date()
    for (const job of jobs) {
      if (!isDue(job, now)) continue
      await runJob(job).catch((err) => log.error(`job ${job.jobName} crashed outside its handler:`, err))
    }
  } catch (err) {
    // Almost always the database being briefly unreachable. The next tick
    // retries; a scheduler that dies on one bad query would silently stop all
    // background work with nothing in the log to say when.
    log.error('scheduler tick failed:', err)
  } finally {
    running = false
  }
}

/**
 * Start ticking.
 *
 * Off by default under test: a timer firing mid-assertion makes failures
 * depend on wall-clock timing, and every job here is exercised directly
 * instead. `FACTORYPILOT_SCHEDULER=off` also stops it in a deployed instance,
 * which is the quickest way to take background work out of the picture while
 * diagnosing something else.
 */
function start() {
  if (timer) return timer
  if (process.env.FACTORYPILOT_SCHEDULER === 'off') {
    log.info('scheduler disabled by FACTORYPILOT_SCHEDULER=off')
    return null
  }
  if (process.env.NODE_ENV === 'test' || process.env.FACTORYPILOT_DEMO_MODE === '1') {
    log.info('scheduler not started under test/demo mode')
    return null
  }
  log.info(`scheduler starting on ${INSTANCE} — tick ${TICK_MS}ms, lease ${LEASE_MS}ms`)
  timer = setInterval(() => tick().catch((err) => log.error('tick threw:', err)), TICK_MS)
  timer.unref?.()
  return timer
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  register, start, stop, tick, isDue, claim, renew, release, runJob,
  INSTANCE, TICK_MS, LEASE_MS,
  /** Test seam: handlers are process-wide, so a test that registers one would
   *  otherwise leak into every test after it. */
  _handlers: handlers,
  _reset() { handlers.clear(); stop(); running = false },
}
