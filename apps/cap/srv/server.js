/**
 * Server bootstrap — the one place background work is switched on.
 *
 * CAP serves the request path without any help from here; this exists solely
 * so the scheduler starts *after* the model is loaded and the services are
 * served. Starting it earlier means the first tick runs against entities that
 * do not exist yet, which fails in a way that looks like a database problem
 * rather than a startup-ordering one.
 *
 * `cds.on('served')` rather than `listening`: jobs need the model and the
 * database, not the HTTP port, and binding the two together would delay work
 * that has nothing to do with serving requests.
 */

const cds = require('@sap/cds')

const scheduler = require('./lib/scheduler')
const jobs = require('./lib/jobs')

cds.on('served', async () => {
  const log = cds.log('server')
  try {
    jobs.registerAll(scheduler)
    await jobs.ensureSeeded()
    scheduler.start()
  } catch (err) {
    // A scheduler that will not start must never stop the application from
    // answering questions. Background work is an addition to the product, not
    // a precondition for it.
    log.error('background jobs could not be started — the request path is unaffected:', err)
  }
})

module.exports = cds.server
