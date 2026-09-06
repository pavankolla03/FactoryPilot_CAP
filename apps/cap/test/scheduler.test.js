const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const scheduler = require('../srv/lib/scheduler')

/**
 * The scheduler, and mostly the lock.
 *
 * Cloud Foundry runs several instances of this application. Everything here
 * exists because a plain timer fires in all of them: the digest goes out three
 * times, the alert pages someone in triplicate, and none of it is visible in
 * testing on one machine. So the concurrency test below is not a nicety — it
 * is the test that says the feature works at all.
 */

const JOB = 'test-job'

async function seed(fields = {}) {
  const { ScheduledJob, JobRun } = cds.entities('factorypilot.jobs')
  await DELETE.from(JobRun).where({ jobName: JOB })
  await DELETE.from(ScheduledJob).where({ jobName: JOB })
  await INSERT.into(ScheduledJob).entries({
    jobName: JOB,
    description: 'exercised by the test suite',
    intervalMinutes: 60,
    isActive: true,
    ...fields,
  })
  return SELECT.one.from(ScheduledJob).where({ jobName: JOB })
}

beforeEach(() => scheduler._reset())
afterEach(async () => {
  scheduler._reset()
  const { ScheduledJob, JobRun } = cds.entities('factorypilot.jobs')
  await DELETE.from(JobRun).where({ jobName: JOB })
  await DELETE.from(ScheduledJob).where({ jobName: JOB })
})

describe('deciding whether a job is due', () => {
  test('a job that has never run is due', () => {
    assert.equal(scheduler.isDue({ intervalMinutes: 60, lastRunAt: null }), true)
  })

  test('an interval job is not due again until the interval has passed', () => {
    const now = new Date('2026-09-06T12:00:00')
    const justRan = new Date('2026-09-06T11:30:00')
    assert.equal(scheduler.isDue({ intervalMinutes: 60, lastRunAt: justRan }, now), false)
    const ranLongAgo = new Date('2026-09-06T10:30:00')
    assert.equal(scheduler.isDue({ intervalMinutes: 60, lastRunAt: ranLongAgo }, now), true)
  })

  test('a daily job runs only in its own hour', () => {
    const job = { runAtHour: 6, lastRunAt: null }
    assert.equal(scheduler.isDue(job, new Date('2026-09-06T05:59:00')), false)
    assert.equal(scheduler.isDue(job, new Date('2026-09-06T06:01:00')), true)
    assert.equal(scheduler.isDue(job, new Date('2026-09-06T07:00:00')), false)
  })

  test('a daily job does not run twice in the same hour', () => {
    // Sixty ticks pass through the 6am hour. Without a same-day check the
    // digest would be sent on every one of them.
    const job = { runAtHour: 6, lastRunAt: new Date('2026-09-06T06:00:30') }
    assert.equal(scheduler.isDue(job, new Date('2026-09-06T06:45:00')), false)
  })

  test('a daily job runs again the next day', () => {
    const job = { runAtHour: 6, lastRunAt: new Date('2026-09-05T06:00:30') }
    assert.equal(scheduler.isDue(job, new Date('2026-09-06T06:00:30')), true)
  })
})

describe('the lease, which is what makes this safe on more than one instance', () => {
  test('an unclaimed job can be claimed', async () => {
    await seed()
    assert.equal(await scheduler.claim(JOB), true)
  })

  test('a job already claimed cannot be claimed again', async () => {
    await seed()
    assert.equal(await scheduler.claim(JOB), true)
    assert.equal(await scheduler.claim(JOB), false, 'a held lease must refuse a second claim')
  })

  test('exactly one of many simultaneous claims wins', async () => {
    // The point of the whole design. Ten instances reach for the same job in
    // the same instant; nine must lose.
    await seed()
    const results = await Promise.all(Array.from({ length: 10 }, () => scheduler.claim(JOB)))
    assert.equal(results.filter(Boolean).length, 1,
      `expected exactly one winner, got ${results.filter(Boolean).length}`)
  })

  test('an expired lease is claimable again', async () => {
    // An instance killed mid-run cannot release anything. A boolean flag would
    // strand the job forever; a lease simply runs out.
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    await seed()
    await UPDATE(ScheduledJob)
      .set({ lockedBy: 'a-container-that-died', lockedUntil: new Date(Date.now() - 60_000) })
      .where({ jobName: JOB })
    assert.equal(await scheduler.claim(JOB), true)
  })

  test('releasing lets the next claim through without waiting for expiry', async () => {
    await seed()
    await scheduler.claim(JOB)
    await scheduler.release(JOB, {})
    assert.equal(await scheduler.claim(JOB), true)
  })
})

describe('running a job', () => {
  test('a successful run is recorded with its summary', async () => {
    const { JobRun } = cds.entities('factorypilot.jobs')
    const job = await seed()
    scheduler.register(JOB, async () => '3 alerts sent')

    await scheduler.runJob(job)

    const run = await SELECT.one.from(JobRun).where({ jobName: JOB })
    assert.equal(run.status, 'SUCCESS')
    assert.equal(run.summary, '3 alerts sent')
    assert.ok(run.durationMs >= 0)
  })

  test('a failing job is recorded rather than thrown', async () => {
    // Background work must never take down the request path people are using.
    const { JobRun, ScheduledJob } = cds.entities('factorypilot.jobs')
    const job = await seed()
    scheduler.register(JOB, async () => { throw new Error('S/4 unreachable') })

    await scheduler.runJob(job)   // must not reject

    const run = await SELECT.one.from(JobRun).where({ jobName: JOB })
    assert.equal(run.status, 'FAILED')
    assert.match(run.summary, /S\/4 unreachable/)
    const after = await SELECT.one.from(ScheduledJob).where({ jobName: JOB })
    assert.equal(after.failureCount, 1, 'consecutive failures should be counted')
  })

  test('a success resets the failure count', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    const job = await seed({ failureCount: 4 })
    scheduler.register(JOB, async () => 'fine now')
    await scheduler.runJob(job)
    const after = await SELECT.one.from(ScheduledJob).where({ jobName: JOB })
    assert.equal(after.failureCount, 0)
  })

  test('the lease is given back after the run', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    const job = await seed()
    scheduler.register(JOB, async () => 'ok')
    await scheduler.runJob(job)
    const after = await SELECT.one.from(ScheduledJob).where({ jobName: JOB })
    assert.equal(after.lockedUntil, null, 'a finished job should not hold its lease')
  })

  test('a job with no registered handler is skipped, not failed', async () => {
    const { JobRun } = cds.entities('factorypilot.jobs')
    const job = await seed()
    await scheduler.runJob(job)          // nothing registered
    const runs = await SELECT.from(JobRun).where({ jobName: JOB })
    assert.equal(runs.length, 0, 'skipping is not the same as running and failing')
  })
})

describe('a tick', () => {
  test('runs a due job and leaves a record', async () => {
    const { JobRun } = cds.entities('factorypilot.jobs')
    await seed({ lastRunAt: null })
    let ran = 0
    scheduler.register(JOB, async () => { ran++; return 'swept' })

    await scheduler.tick()

    assert.equal(ran, 1)
    const runs = await SELECT.from(JobRun).where({ jobName: JOB })
    assert.equal(runs.length, 1)
  })

  test('does not run a job that is not due', async () => {
    await seed({ lastRunAt: new Date(), intervalMinutes: 60 })
    let ran = 0
    scheduler.register(JOB, async () => { ran++; return 'x' })
    await scheduler.tick()
    assert.equal(ran, 0)
  })

  test('skips an inactive job', async () => {
    await seed({ isActive: false, lastRunAt: null })
    let ran = 0
    scheduler.register(JOB, async () => { ran++; return 'x' })
    await scheduler.tick()
    assert.equal(ran, 0)
  })
})
