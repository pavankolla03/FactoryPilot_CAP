const cds = require('@sap/cds')
const backend = require('./lib/backend')

/** Probe a connection's `$metadata`. Reports honestly when no credential is
 *  configured rather than returning a green an admin would trust. */
async function probe(connection) {
  const started = Date.now()
  const base = (connection.baseUrl || '').replace(/\/$/, '')
  const checkedUrl = base ? `${base}/$metadata` : ''

  if (connection.kind === 'mock') {
    return { ok: true, statusCode: 200, message: 'Mock connection — no network call made', checkedUrl: 'mock://', elapsedMs: 0 }
  }
  if (!checkedUrl) {
    return { ok: false, statusCode: 0, message: 'No baseUrl configured', checkedUrl: '', elapsedMs: 0 }
  }

  const secret = connection.credentialRef ? process.env[connection.credentialRef] : undefined
  if (connection.authMode !== 'none' && !secret) {
    return {
      ok: false,
      statusCode: 0,
      message: `No credential found in env var "${connection.credentialRef || '(unset)'}" — set it and retry`,
      checkedUrl,
      elapsedMs: 0,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), connection.timeoutMs || 15000)
  try {
    const res = await fetch(checkedUrl, {
      headers: { Accept: 'application/xml', ...(secret && { APIKey: secret }) },
      signal: controller.signal,
    })
    return {
      ok: res.ok,
      statusCode: res.status,
      message: res.ok ? 'Metadata reachable' : `Upstream returned ${res.status} ${res.statusText}`,
      checkedUrl,
      elapsedMs: Date.now() - started,
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      message: err.name === 'AbortError' ? 'Timed out' : `Request failed: ${err.message}`,
      checkedUrl,
      elapsedMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = cds.service.impl(function () {
  const { BusinessObjects, Connections } = this.entities
  const { Connection } = cds.entities('factorypilot.config')

  this.on('testConnection', BusinessObjects, async (req) => {
    const id = req.params[0]?.ID ?? req.params[0]
    const bo = await SELECT.one.from(BusinessObjects).where({ ID: id })
    if (!bo) return req.reject(404, 'Business object not found')

    const connection = bo.connection_ID
      ? await SELECT.one.from(Connection).where({ ID: bo.connection_ID })
      : { kind: 'mock' }

    // Prefer the object's own Hub URL when it has one; connections can be shared.
    const result = await probe({ ...connection, baseUrl: bo.hubApiUrl || connection.baseUrl })
    return result
  })

  this.on('test', Connections, async (req) => {
    const id = req.params[0]?.ID ?? req.params[0]
    const connection = await SELECT.one.from(Connections).where({ ID: id })
    if (!connection) return req.reject(404, 'Connection not found')

    const result = await probe(connection)
    await UPDATE(Connection)
      .set({ lastTestStatus: result.ok ? 'OK' : 'FAILED', lastTestedAt: new Date(), lastTestMessage: result.message })
      .where({ ID: id })
    return result
  })

  // objectCode is the join key the agent resolves tools against; the path and
  // entity set are what it builds queries from. An active row missing either
  // produces a tool that always fails.
  this.before(['CREATE', 'UPDATE'], BusinessObjects, (req) => {
    const d = req.data
    if (d.objectCode) d.objectCode = d.objectCode.toUpperCase()
    if (d.isActive) {
      if (!d.odataServicePath) req.error(400, 'odataServicePath is required to activate', 'odataServicePath')
      if (!d.entitySet) req.error(400, 'entitySet is required to activate', 'entitySet')
    }
  })

  this.after('READ', Connections, (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row) row.testCriticality = row.lastTestStatus === 'OK' ? 3 : row.lastTestStatus ? 1 : 0
    }
  })

  // A secret in this column would land in the database and every audit export
  // of it. Only the name of the credential belongs here.
  this.before(['CREATE', 'UPDATE'], Connections, (req) => {
    const ref = req.data.credentialRef
    if (ref && /[^A-Z0-9_]/.test(ref)) {
      req.error(400, 'credentialRef must be an env var name (A-Z, 0-9, underscore) — never the secret itself', 'credentialRef')
    }
  })
})
