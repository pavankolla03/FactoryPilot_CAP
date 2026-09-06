const cds = require('@sap/cds')

const scheduler = require('./lib/scheduler')
const jobsLib = require('./lib/jobs')
const digest = require('./lib/digest')
const exportsLib = require('./lib/exports')

/**
 * Background jobs over OData. (BETA)
 *
 * Thin on purpose: the scheduling and locking live in lib/scheduler.js, and
 * this only exposes them. The one piece of real behaviour here is `runNow`,
 * and it deliberately goes through the same lease as a scheduled run rather
 * than calling the handler directly — an administrator pressing "run now"
 * while the 6am run is in flight must not produce two concurrent digests.
 */
module.exports = class JobsService extends cds.ApplicationService {
  async init() {
    const { ScheduledJobs } = this.entities

    this.on('runNow', async (req) => {
      const jobName = req.data.jobName
      const { ScheduledJob } = cds.entities('factorypilot.jobs')
      const job = await SELECT.one.from(ScheduledJob).where({ jobName })
      if (!job) return req.reject(404, `No job named "${jobName}".`)

      // Handlers are registered at startup by srv/server.js. In a fresh
      // process — or a test — that may not have happened yet, and a bare
      // "nothing happened" would be baffling.
      if (!scheduler._handlers.has(jobName)) jobsLib.registerAll(scheduler)

      const started = Date.now()
      await scheduler.runJob(job)
      const after = await SELECT.one.from(ScheduledJob).where({ jobName })

      // runJob is deliberately silent when another instance holds the lease.
      // Saying so is better than reporting a success that did not happen here.
      const ranHere = after.lastRunAt && new Date(after.lastRunAt).getTime() >= started - 1000
      return {
        jobName,
        status: ranHere ? after.lastRunStatus : 'SKIPPED',
        summary: ranHere
          ? after.lastRunMessage
          : 'Another instance is already running this job — nothing was run here.',
        ranMs: ranHere ? after.lastRunMs : 0,
      }
    })

    this.on('exportReport', async (req) => {
      try {
        const built = await exportsLib.build(req.data.name, { days: req.data.days || undefined })
        return {
          name: built.name, title: built.title, filename: built.filename,
          rowCount: built.rowCount, days: built.days, csv: built.csv,
        }
      } catch (err) {
        // Naming the known reports beats a bare 400 — the caller almost always
        // wants one of them and has mistyped it.
        return req.reject(400, err.message)
      }
    })

    this.on('previewDigest', async () => {
      const built = await digest.build()
      return {
        text: built.text,
        sections: built.sections.length,
        unreadable: built.unreadable,
        generatedAt: built.generatedAt,
      }
    })

    // A job whose interval is minutes rather than hours will hammer whatever
    // it reads. The floor is a guard against a typo in a form field, not a
    // policy — an operator who genuinely wants it can edit the row directly.
    this.before(['CREATE', 'UPDATE', 'SAVE'], ScheduledJobs, (req) => {
      const d = req.data || {}
      if (d.intervalMinutes !== undefined && d.intervalMinutes !== null && d.intervalMinutes < 5) {
        req.error(400, 'Interval must be at least 5 minutes.', 'in/intervalMinutes')
      }
      if (d.runAtHour !== undefined && d.runAtHour !== null && (d.runAtHour < 0 || d.runAtHour > 23)) {
        req.error(400, 'Run-at hour must be between 0 and 23.', 'in/runAtHour')
      }
    })

    await super.init()
  }
}
