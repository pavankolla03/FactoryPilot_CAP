const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { GET, POST } = cds.test(PROJECT).in(PROJECT)

const digest = require('../srv/lib/digest')
const notify = require('../srv/lib/notify')
const jobs = require('../srv/lib/jobs')

/**
 * The digest, and mostly how it fails.
 *
 * This is delivered at six in the morning to someone who is not watching logs.
 * Everything below is about that: a section that cannot be read has to *say*
 * it could not be read, because a silently missing section is indistinguishable
 * from "nothing to report" — and those two facts lead to opposite actions.
 */

describe('building the digest', () => {
  test('it reports every configured section, whatever happens to each', async () => {
    const built = await digest.build()
    assert.equal(built.sections.length, digest.SECTIONS.length)
    for (const s of built.sections) {
      const accounted = s.rowCount !== undefined || s.error !== undefined || s.skipped !== undefined
      assert.ok(accounted, `${s.key} was neither read, skipped, nor failed`)
    }
  })

  test('a section that cannot be read says so, rather than reading as empty', () => {
    const text = digest.render({
      generatedAt: new Date('2026-09-06T06:00:00'),
      warehouse: '1710',
      sections: [
        { key: 'PURCHASING', title: 'Purchase orders', error: 'Graph returned HTTP 401' },
        { key: 'DELIVERY', title: 'Deliveries', rowCount: 0, lead: (n) => (n ? `${n} deliveries` : 'No deliveries today') },
      ],
      activity: null,
    })
    assert.match(text, /Purchase orders: could not be read — Graph returned HTTP 401/)
    assert.match(text, /Deliveries: No deliveries today/)
    // The distinction has to survive into the closing note as well.
    assert.match(text, /1 section could not be read/)
    assert.match(text, /connection problem, not an empty result/)
  })

  test('a fully readable digest does not warn about incompleteness', () => {
    const text = digest.render({
      generatedAt: new Date('2026-09-06T06:00:00'),
      warehouse: '1710',
      sections: [{ key: 'DELIVERY', title: 'Deliveries', rowCount: 3, lead: (n) => `${n} deliveries in scope` }],
      activity: null,
    })
    assert.match(text, /3 deliveries in scope/)
    assert.doesNotMatch(text, /could not be read/)
  })

  test('it is marked BETA on the face of it', () => {
    const text = digest.render({
      generatedAt: new Date(), warehouse: '', sections: [], activity: null,
    })
    assert.match(text, /\[BETA\]/)
  })

  test('activity is counted from the audit log', () => {
    const text = digest.render({
      generatedAt: new Date(), warehouse: '', sections: [],
      activity: { total: 12, failed: 2, grounded: 9, cached: 4 },
    })
    assert.match(text, /12 questions asked/)
    assert.match(text, /9 answered from data/)
    assert.match(text, /2 failed/)
  })

  test('a quiet day reads as quiet, not as broken', () => {
    const text = digest.render({
      generatedAt: new Date(), warehouse: '', sections: [],
      activity: { total: 0, failed: 0, grounded: 0, cached: 0 },
    })
    assert.match(text, /0 questions asked/)
    assert.match(text, /none failed/)
  })
})

describe('delivery', () => {
  test('no webhook configured is reported, not thrown', async () => {
    const { OrgSettings } = cds.entities('factorypilot.admin')
    const before = await SELECT.one.from(OrgSettings)
    await UPDATE(OrgSettings).set({ webhookUrl: null })
    const res = await notify.send('t', 'body')
    assert.equal(res.delivered, false)
    assert.match(res.reason, /no webhookUrl/)
    if (before) await UPDATE(OrgSettings).set({ webhookUrl: before.webhookUrl })
  })

  test('an unreachable webhook fails softly', async () => {
    const { OrgSettings } = cds.entities('factorypilot.admin')
    const before = await SELECT.one.from(OrgSettings)
    await UPDATE(OrgSettings).set({ webhookUrl: 'http://127.0.0.1:9/never-listening' })
    const res = await notify.send('t', 'body')
    assert.equal(res.delivered, false)
    assert.ok(res.reason, 'a failure must carry a reason')
    if (before) await UPDATE(OrgSettings).set({ webhookUrl: before.webhookUrl })
  })

  test('the payload works for Teams and Slack without configuration', () => {
    // Both render a bare `text` field. Sending it alongside the structured
    // fields means one payload serves a chat channel and a custom consumer.
    const p = notify.payloadFor('Digest', 'two lines\nof body')
    assert.match(p.text, /\*\*Digest\*\*/)
    assert.equal(p.body, 'two lines\nof body')
    assert.equal(p.beta, true)
  })
})

describe('job seeding', () => {
  test('seeding creates the digest job and does not overwrite it afterwards', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    await DELETE.from(ScheduledJob).where({ jobName: 'daily-digest' })

    await jobs.ensureSeeded()
    const first = await SELECT.one.from(ScheduledJob).where({ jobName: 'daily-digest' })
    assert.ok(first, 'the digest job should be seeded')

    // An administrator turns it off and moves it. A second seed must respect that.
    await UPDATE(ScheduledJob).set({ isActive: false, runAtHour: 7 }).where({ jobName: 'daily-digest' })
    await jobs.ensureSeeded()
    const second = await SELECT.one.from(ScheduledJob).where({ jobName: 'daily-digest' })
    assert.equal(second.isActive, false, 'seeding must not re-enable a job an admin disabled')
    assert.equal(second.runAtHour, 7, 'seeding must not move a job an admin rescheduled')
  })

  test('the digest hour comes from OrgSettings', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    const { OrgSettings } = cds.entities('factorypilot.admin')
    const before = await SELECT.one.from(OrgSettings)
    await UPDATE(OrgSettings).set({ digestHour: 9 })
    await DELETE.from(ScheduledJob).where({ jobName: 'daily-digest' })

    await jobs.ensureSeeded()
    const seeded = await SELECT.one.from(ScheduledJob).where({ jobName: 'daily-digest' })
    assert.equal(seeded.runAtHour, 9, 'digestHour has been a dead field; it should now drive the schedule')

    if (before) await UPDATE(OrgSettings).set({ digestHour: before.digestHour })
  })
})

/**
 * The service layer.
 *
 * Thin, but worth covering: everything above is unit-tested against the
 * libraries directly, and none of that would catch a route that was never
 * wired, a scope that locks out the people who need it, or a validation that
 * fires on the wrong operation.
 */
describe('the jobs service', () => {
  const ADMIN = { auth: { username: 'admin', password: 'admin' } }
  const VIEWER = { auth: { username: 'viewer', password: 'viewer' } }

  test('an administrator can list the scheduled jobs', async () => {
    const { data } = await GET('/odata/jobs/ScheduledJobs?$select=jobName,isActive', ADMIN)
    assert.ok(Array.isArray(data.value))
    assert.ok(data.value.some((j) => j.jobName === 'daily-digest'),
      'the digest job should be listed once seeded')
  })

  test('the last result is coloured so a failed overnight run stands out', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    await UPDATE(ScheduledJob).set({ lastRunStatus: 'FAILED' }).where({ jobName: 'daily-digest' })
    const { data } = await GET('/odata/jobs/ScheduledJobs?$select=jobName,lastRunCriticality', ADMIN)
    const row = data.value.find((j) => j.jobName === 'daily-digest')
    assert.equal(row.lastRunCriticality, 1, 'a failed run should read as negative criticality')

    await UPDATE(ScheduledJob).set({ lastRunStatus: 'SUCCESS' }).where({ jobName: 'daily-digest' })
    const { data: ok } = await GET('/odata/jobs/ScheduledJobs?$select=jobName,lastRunCriticality', ADMIN)
    assert.equal(ok.value.find((j) => j.jobName === 'daily-digest').lastRunCriticality, 3)
  })

  test('the digest can be previewed without sending it to anybody', async () => {
    // Preview and run are deliberately separate actions. If the only way to
    // see what the digest says were to run it, every check would notify
    // everyone on the webhook.
    const { data } = await GET('/odata/jobs/previewDigest()', ADMIN)
    assert.ok(data.text.includes('IntelliOps4 digest'))
    assert.ok(data.sections > 0)
  })

  /**
   * ScheduledJobs is draft-enabled, so a POST creates a *draft* — which is
   * allowed to be incomplete, that being the point of a draft. The validation
   * therefore fires on activation, and a test that only POSTs proves nothing
   * about it. Create, then activate, the way the Admin UI does.
   */
  const createActive = async (payload) => {
    const { data: draft } = await POST('/odata/jobs/ScheduledJobs', payload, ADMIN)
    return POST(
      `/odata/jobs/ScheduledJobs(ID=${draft.ID},IsActiveEntity=false)/JobsService.draftActivate`,
      {}, ADMIN)
  }

  /**
   * Activation reports every broken rule at once, so the top-level message is
   * only ever "Multiple errors occurred". The rule under test is in the
   * details, and asserting on the wrapper would pass for any validation
   * failure at all — including the wrong one.
   */
  const rejectionText = async (fn) => {
    try { await fn(); return null } catch (err) {
      return JSON.stringify(err.response?.data ?? err.message ?? err)
    }
  }

  test('a nonsense interval is refused on activation', async () => {
    const text = await rejectionText(() => createActive({ jobName: 'too-fast', intervalMinutes: 1 }))
    assert.ok(text, 'activating a 1-minute job should be refused')
    assert.match(text, /at least 5 minutes/)
  })

  test('an hour outside the day is refused on activation', async () => {
    const text = await rejectionText(() => createActive({ jobName: 'bad-hour', runAtHour: 25 }))
    assert.ok(text, 'activating an out-of-range hour should be refused')
    assert.match(text, /between 0 and 23/)
  })

  test('a sensible job activates cleanly', async () => {
    const { ScheduledJob } = cds.entities('factorypilot.jobs')
    await DELETE.from(ScheduledJob).where({ jobName: 'fine-job' })
    await createActive({ jobName: 'fine-job', intervalMinutes: 30, runAtHour: 6 })
    const row = await SELECT.one.from(ScheduledJob).where({ jobName: 'fine-job' })
    assert.ok(row, 'a valid job should activate')
    await DELETE.from(ScheduledJob).where({ jobName: 'fine-job' })
  })

  test('a read-only user cannot trigger a job', async () => {
    await assert.rejects(
      () => POST('/odata/jobs/runNow', { jobName: 'daily-digest' }, VIEWER))
  })

  test('running an unknown job is a clear 404, not a silent nothing', async () => {
    await assert.rejects(
      () => POST('/odata/jobs/runNow', { jobName: 'no-such-job' }, ADMIN),
      /No job named/)
  })
})
