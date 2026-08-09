const cds = require('@sap/cds')

/**
 * Validate a registered OData service before an admin activates it.
 *
 * Against the Hub sandbox this needs SAP_HUB_API_KEY. Without a key we say so
 * plainly rather than reporting a false green — an admin who sees "ok" here
 * will assume the destination is wired.
 */
async function testConnection(req) {
  const { BusinessObjectConfigs } = this.entities
  const row = await SELECT.one.from(BusinessObjectConfigs).where({ ID: req.params[0]?.ID ?? req.params[0] })

  if (!row) return req.reject(404, 'Business object not found')
  if (!row.hubApiUrl && !row.odataServicePath) {
    return { ok: false, statusCode: 0, message: 'No hubApiUrl or odataServicePath configured', checkedUrl: '' }
  }

  const base = (row.hubApiUrl || '').replace(/\/$/, '')
  const checkedUrl = base ? `${base}/$metadata` : `${row.odataServicePath}/$metadata`

  const apiKey = process.env.SAP_HUB_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      statusCode: 0,
      message: 'SAP_HUB_API_KEY is not set — cannot reach the Accelerator Hub sandbox. Set it in .env and retry.',
      checkedUrl,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(checkedUrl, {
      headers: { APIKey: apiKey, Accept: 'application/xml' },
      signal: controller.signal,
    })
    return {
      ok: res.ok,
      statusCode: res.status,
      message: res.ok ? 'Metadata reachable' : `Upstream returned ${res.status} ${res.statusText}`,
      checkedUrl,
    }
  } catch (err) {
    const aborted = err.name === 'AbortError'
    return {
      ok: false,
      statusCode: 0,
      message: aborted ? 'Timed out after 10s' : `Request failed: ${err.message}`,
      checkedUrl,
    }
  } finally {
    clearTimeout(timer)
  }
}

const CRITICALITY = { SUCCESS: 3, RATE_LIMITED: 2, ERROR: 1 }

module.exports = cds.service.impl(function () {
  this.on('testConnection', 'BusinessObjectConfigs', testConnection.bind(this))

  this.after('READ', 'CommunicationLogs', (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row) row.statusCriticality = CRITICALITY[row.status] ?? 0
    }
  })

  // objectCode is the join key the orchestrator resolves intents against, and
  // the OData path is what it builds queries from. Both must exist before a row
  // can go live, or IntentResolve matches a config it cannot execute.
  this.before(['CREATE', 'UPDATE'], 'BusinessObjectConfigs', (req) => {
    const d = req.data
    if (d.isActive) {
      if (!d.odataServicePath) req.error(400, 'odataServicePath is required to activate', 'odataServicePath')
      if (!d.entitySet) req.error(400, 'entitySet is required to activate', 'entitySet')
    }
    if (d.objectCode) d.objectCode = d.objectCode.toUpperCase()
  })
})
