/**
 * The jobs themselves, and the rows that describe them. (BETA)
 *
 * `scheduler.js` knows how to run work exactly once across instances; this
 * knows what the work *is*. Kept apart so a new job is one entry here rather
 * than a change to the locking, which is the part that must not be disturbed.
 */

const cds = require('@sap/cds')

const digest = require('./digest')
const watchers = require('./watchers')
const anomaly = require('./anomaly')
const asyncrun = require('./asyncrun')
const exports_ = require('./exports')
const notify = require('./notify')

const log = cds.log('jobs')

/**
 * Every job, with the row that should exist for it.
 *
 * `defaults` seeds the ScheduledJob row on first start. They are defaults, not
 * settings: once the row exists an administrator owns it, and re-seeding would
 * quietly undo their choice on every deploy.
 */
const JOBS = [
  {
    name: 'daily-digest',
    defaults: {
      description: 'Morning brief: open orders, counts, deliveries and yesterday’s activity (BETA)',
      runAtHour: null,      // resolved from OrgSettings.digestHour at seed time
      intervalMinutes: 1440,
      isActive: true,
    },
    async handler() {
      const built = await digest.build()
      const delivery = await notify.send('IntelliOps4 daily digest', built.text, {
        sections: built.sections.map((s) => ({
          key: s.key, title: s.title,
          rows: s.rowCount ?? null, error: s.error ?? null, skipped: s.skipped ?? null,
        })),
      })

      // Deliberately one summary covering both facts. "Built but not delivered"
      // is a different problem from "could not be built", and a reader of
      // JobRun should not have to guess which happened.
      const parts = [`${built.sections.length} sections`]
      if (built.unreadable) parts.push(`${built.unreadable} unreadable`)
      parts.push(delivery.delivered ? 'delivered' : `not delivered (${delivery.reason})`)
      return parts.join(', ')
    },
  },
  {
    name: 'watcher-sweep',
    defaults: {
      description: 'Evaluate standing watchers and alert when one is newly breached (BETA)',
      runAtHour: null,
      intervalMinutes: 15,
      isActive: true,
    },
    async handler() {
      const result = await watchers.sweep()
      if (!result.checked) return 'no watchers configured'

      // Only speak when something changed. A sweep that finds everything as it
      // was is the normal case, and reporting it every fifteen minutes would
      // bury the sweeps that actually found something.
      const changed = result.alerts.length + result.cleared.length
      if (!changed && !result.errors.length) return `${result.checked} watchers checked, nothing changed`

      let delivery = { delivered: false, reason: 'nothing worth sending' }
      if (changed || result.errors.length) {
        delivery = await notify.send(
          result.alerts.length ? 'IntelliOps4 alert' : 'IntelliOps4 watchers',
          watchers.render(result),
          { alerts: result.alerts, cleared: result.cleared, errors: result.errors })
      }
      const parts = [`${result.checked} checked`]
      if (result.alerts.length) parts.push(`${result.alerts.length} newly breached`)
      if (result.cleared.length) parts.push(`${result.cleared.length} cleared`)
      if (result.errors.length) parts.push(`${result.errors.length} unreadable`)
      parts.push(delivery.delivered ? 'delivered' : `not delivered (${delivery.reason})`)
      return parts.join(', ')
    },
  },
  {
    name: 'anomaly-sweep',
    defaults: {
      description: 'Watch each business object against its own history and flag what looks unusual (BETA)',
      runAtHour: null,
      intervalMinutes: 180,
      isActive: true,
    },
    async handler() {
      const result = await anomaly.sweep()
      if (!result.observed && !result.errors.length) return 'nothing to observe'

      // Silent unless something is unusual. This runs every three hours; a
      // message each time saying "all normal" would be the fastest possible
      // route to being filtered into a folder nobody opens.
      if (!result.findings.length) {
        const quiet = `${result.observed} observed, nothing unusual`
        return result.errors.length ? `${quiet}, ${result.errors.length} unreadable` : quiet
      }

      const delivery = await notify.send('IntelliOps4 — something looks unusual',
        anomaly.render(result), { findings: result.findings, errors: result.errors })
      const parts = [`${result.observed} observed`, `${result.findings.length} flagged`]
      if (result.errors.length) parts.push(`${result.errors.length} unreadable`)
      parts.push(delivery.delivered ? 'delivered' : `not delivered (${delivery.reason})`)
      return parts.join(', ')
    },
  },
  {
    name: 'async-questions',
    defaults: {
      description: 'Answer questions that were queued because they need longer than a request allows (BETA)',
      runAtHour: null,
      intervalMinutes: 5,
      isActive: true,
    },
    async handler() {
      const r = await asyncrun.sweep()
      if (!r.taken && !r.expired) return 'nothing queued'
      const parts = []
      if (r.taken) parts.push(`${r.taken} answered`)
      if (r.expired) parts.push(`${r.expired} expired`)
      return parts.join(', ')
    },
  },
  {
    name: 'weekly-export',
    defaults: {
      description: 'Build the usage, quality and failure reports and send them on (BETA)',
      runAtHour: 7,
      intervalMinutes: 10080,
      // Off until somebody asks for it. A weekly file arriving unrequested is
      // the definition of noise, and the seeder never re-enables what an
      // administrator has switched off.
      isActive: false,
    },
    async handler() {
      const reports = await exports_.buildAll()
      const delivery = await notify.send('IntelliOps4 weekly export', exports_.describe(reports),
        { reports: reports.map((r) => r.error
          ? { name: r.name, error: r.error }
          : { name: r.name, title: r.title, rows: r.rowCount, filename: r.filename, csv: r.csv }) })
      const built = reports.filter((r) => !r.error).length
      const failed = reports.length - built
      const parts = [`${built} report${built === 1 ? '' : 's'} built`]
      if (failed) parts.push(`${failed} failed`)
      parts.push(delivery.delivered ? 'delivered' : `not delivered (${delivery.reason})`)
      return parts.join(', ')
    },
  },
]

/** Hand every job to the scheduler. */
function registerAll(scheduler) {
  for (const job of JOBS) scheduler.register(job.name, job.handler)
  log.info(`registered ${JOBS.length} background job${JOBS.length === 1 ? '' : 's'}`)
}

/**
 * Create the ScheduledJob row for any job that does not have one.
 *
 * Insert-if-absent, never update. An administrator who has turned the digest
 * off, or moved it to 07:00, must not have that reversed by the next deploy —
 * which is exactly what a blind upsert here would do.
 */
async function ensureSeeded() {
  const { ScheduledJob } = cds.entities('factorypilot.jobs')
  const { OrgSettings } = cds.entities('factorypilot.admin')

  // digestHour has existed in the model from the start with nothing reading it.
  // This is the code that finally makes the field mean something.
  let digestHour = 6
  try {
    const org = await SELECT.one.from(OrgSettings)
    if (org && Number.isInteger(org.digestHour)) digestHour = org.digestHour
  } catch {
    /* fall back to 6 — a missing OrgSettings row is not a reason to skip seeding */
  }

  for (const job of JOBS) {
    const existing = await SELECT.one.from(ScheduledJob).where({ jobName: job.name })
    if (existing) continue
    const defaults = { ...job.defaults }
    if (job.name === 'daily-digest') defaults.runAtHour = digestHour
    await INSERT.into(ScheduledJob).entries({ jobName: job.name, ...defaults })
    log.info(`seeded job ${job.name}` + (defaults.runAtHour != null ? ` at ${defaults.runAtHour}:00` : ''))
  }
}

module.exports = { JOBS, registerAll, ensureSeeded }
