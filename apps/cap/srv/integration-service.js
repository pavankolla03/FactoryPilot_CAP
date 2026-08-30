const cds = require('@sap/cds')

const KINDS = ['iflow', 'odata_direct', 'graph', 'hub_sandbox', 'destination', 'mock']
const AUTH_MODES = ['none', 'api_key', 'bearer', 'basic', 'oauth2_client_credentials']

/**
 * Anything that looks like a live secret rather than the *name* of one.
 * Storing the secret here would put it in the database, every backup and every
 * export of this table — so it is refused at the edge with an explanation.
 */
const SECRET_SHAPED = /^(sk-|gho_|ghp_|xox[baprs]-|AKIA[0-9A-Z]{16}|Bearer\s)|^[A-Za-z0-9_\-]{40,}$/

function credentialFor(endpoint) {
  return endpoint.credentialRef ? process.env[endpoint.credentialRef] : undefined
}

/** Build the auth headers a given endpoint needs, or say what is missing. */
function authHeaders(endpoint) {
  const secret = credentialFor(endpoint)
  switch (endpoint.authMode) {
    case 'none':
      return { headers: {} }
    case 'api_key':
      if (!secret) return { missing: endpoint.credentialRef || 'credentialRef' }
      return { headers: { [endpoint.authHeaderName || 'APIKey']: secret } }
    case 'bearer':
      if (!secret) return { missing: endpoint.credentialRef || 'credentialRef' }
      return { headers: { Authorization: `Bearer ${secret}` } }
    case 'basic':
      if (!secret) return { missing: endpoint.credentialRef || 'credentialRef' }
      // Expect "user:password" in the referenced variable.
      return { headers: { Authorization: `Basic ${Buffer.from(secret).toString('base64')}` } }
    case 'oauth2_client_credentials':
      // Token exchange happens in the runtime client, not in a connectivity
      // test — a test should not mint tokens as a side effect.
      return { headers: {}, note: 'OAuth2 token exchange is not performed by Test' }
    default:
      return { headers: {} }
  }
}

async function runTest(endpoint, userID) {
  const started = Date.now()

  if (endpoint.kind === 'mock') {
    return {
      status: 'OK', httpStatus: 200, durationMs: 0,
      urlTested: 'mock://fixture',
      message: 'Mock endpoint — always reachable, serves the bundled fixture.',
    }
  }

  const base = (endpoint.url || '').replace(/\/$/, '')
  if (!base) {
    return {
      status: 'UNCONFIGURED', httpStatus: 0, durationMs: 0, urlTested: '',
      message: endpoint.destinationName
        ? `Only a BTP destination (${endpoint.destinationName}) is set. Test needs a URL it can call directly.`
        : 'No URL configured.',
    }
  }

  const auth = authHeaders(endpoint)
  if (auth.missing) {
    return {
      status: 'UNCONFIGURED', httpStatus: 0, durationMs: 0, urlTested: base,
      message: `Environment variable "${auth.missing}" is not set on the server, so this endpoint cannot authenticate.`,
    }
  }

  // A health path is a cheap GET; without one, probe the base URL rather than
  // firing a real query — a connectivity test must not have side effects.
  const url = endpoint.healthPath ? `${base}${endpoint.healthPath}` : base
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs || 15000)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...auth.headers },
      signal: controller.signal,
    })
    const durationMs = Date.now() - started
    const ok = res.status < 400
    return {
      status: ok ? 'OK' : 'FAILED',
      httpStatus: res.status,
      durationMs,
      urlTested: url,
      message: ok
        ? `Reachable — HTTP ${res.status} in ${durationMs}ms.${auth.note ? ' ' + auth.note : ''}`
        : `Endpoint answered HTTP ${res.status}. Check the path and credentials.`,
    }
  } catch (err) {
    const durationMs = Date.now() - started
    return {
      status: 'FAILED',
      httpStatus: 0,
      durationMs,
      urlTested: url,
      message:
        err.name === 'AbortError'
          ? `No response within ${endpoint.timeoutMs || 15000}ms.`
          : `Could not reach the endpoint: ${err.message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = cds.service.impl(function () {
  const { Endpoints } = this.entities

  this.before(['CREATE', 'UPDATE', 'SAVE'], Endpoints, (req) => {
    const d = req.data

    if (d.kind && !KINDS.includes(d.kind)) {
      req.error(400, `kind must be one of ${KINDS.join(', ')}`, 'kind')
    }
    if (d.authMode && !AUTH_MODES.includes(d.authMode)) {
      req.error(400, `authMode must be one of ${AUTH_MODES.join(', ')}`, 'authMode')
    }
    if (d.credentialRef && SECRET_SHAPED.test(d.credentialRef.trim())) {
      req.error(
        400,
        'That looks like the secret itself. This field takes the NAME of the environment variable holding it (e.g. IFLOW_TOKEN), so the secret never reaches the database.',
        'credentialRef'
      )
    }
    if (d.authMode && d.authMode !== 'none' && d.credentialRef === '') {
      req.error(400, `authMode "${d.authMode}" needs a credentialRef`, 'credentialRef')
    }
    if (d.url && !/^https:\/\//i.test(d.url) && !/^http:\/\/localhost/i.test(d.url)) {
      // Plain http to anything but localhost would send credentials in clear.
      req.error(400, 'Endpoint URL must be https (http is allowed only for localhost).', 'url')
    }
    if (d.timeoutMs != null && (d.timeoutMs < 500 || d.timeoutMs > 120000)) {
      req.error(400, 'timeoutMs must be between 500 and 120000', 'timeoutMs')
    }
  })

  this.after('READ', Endpoints, (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (!row) continue
      row.testCriticality = row.lastTestStatus === 'OK' ? 3 : row.lastTestStatus ? 1 : 0
    }
  })

  this.on('test', Endpoints, async (req) => {
    const { IntegrationEndpoint, EndpointTest } = cds.entities('factorypilot.integration')
    const id = req.params[0]?.ID ?? req.params[0]
    const endpoint = await SELECT.one.from(IntegrationEndpoint).where({ ID: id })
    if (!endpoint) return req.reject(404, 'Endpoint not found')

    const result = await runTest(endpoint, req.user.id)

    await UPDATE(IntegrationEndpoint)
      .set({
        lastTestStatus: result.status,
        lastTestedAt: new Date(),
        lastTestMessage: result.message.slice(0, 500),
        lastTestMs: result.durationMs,
      })
      .where({ ID: id })

    // Keep the history: "it worked on Monday" is the question people ask.
    await INSERT.into(EndpointTest).entries({
      ID: cds.utils.uuid(),
      endpoint_ID: id,
      testedAt: new Date(),
      testedBy: req.user.id,
      status: result.status,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      urlTested: result.urlTested.slice(0, 400),
      message: result.message.slice(0, 500),
    })

    return result
  })

  // Deactivating an endpoint that business objects still point at would break
  // them at the next question rather than here, where it can be explained.
  this.before('UPDATE', Endpoints, async (req) => {
    if (req.data.isActive !== false) return
    const { BusinessObjectConfig } = cds.entities('factorypilot.config')
    const id = req.params[0]?.ID ?? req.params[0]
    const users = await SELECT.from(BusinessObjectConfig).where({ endpoint_ID: id, isActive: true })
    if (users.length) {
      req.error(
        400,
        `Still in use by ${users.length} active business object(s): ${users.map((u) => u.objectCode).join(', ')}. Point them elsewhere first.`,
        'isActive'
      )
    }
  })
})

module.exports.runTest = runTest
module.exports.authHeaders = authHeaders
module.exports.SECRET_SHAPED = SECRET_SHAPED
