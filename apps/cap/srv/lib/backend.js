/**
 * The one place that talks to a backend system.
 *
 * Three interchangeable modes chosen by the Connection row, so registering a
 * business object against a real S/4 tenant instead of the sandbox is a config
 * change rather than a code change:
 *   mock         — replay the synthetic fixture, no SAP account needed
 *   hub_sandbox  — SAP Business Accelerator Hub with an API key
 *   cpi          — POST the resolved query to the thin generic iFlow
 */

const fs = require('node:fs')
const path = require('node:path')

const FIXTURE = path.join(__dirname, '../../../../docs/api/hub/delivery/sample_response.synthetic.json')

class BackendError extends Error {
  constructor(message, statusCode = 502) {
    super(message)
    this.statusCode = statusCode
  }
}

/** OData v2 nests under d.results; v4 uses a flat `value` array. */
function extractRows(body) {
  if (!body || typeof body !== 'object') return []
  if (body.d && Array.isArray(body.d.results)) return body.d.results
  if (Array.isArray(body.d)) return body.d
  if (Array.isArray(body.value)) return body.value
  return []
}

function buildQueryString({ filter, select, top, apiVersion }) {
  const parts = []
  if (filter) parts.push(`$filter=${filter}`)
  if (select) parts.push(`$select=${select}`)
  if (top) parts.push(`$top=${top}`)
  if (apiVersion === 'v2') parts.push('$format=json')
  return parts.join('&')
}

const toDate = (value) => {
  if (value == null) return ''
  const text = String(value)
  const ticks = text.match(/^\/Date\((\d+)/)
  if (ticks) return new Date(Number(ticks[1])).toISOString().slice(0, 10)
  return text.slice(0, 10)
}

function shiftDates(row, days) {
  const out = { ...row }
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith('Date')) continue
    const iso = toDate(value)
    if (!iso) continue
    const moved = new Date(`${iso}T00:00:00Z`)
    moved.setUTCDate(moved.getUTCDate() + days)
    out[key] = String(value).startsWith('/Date(')
      ? `/Date(${moved.getTime()})/`
      : moved.toISOString().slice(0, 10)
  }
  return out
}

/** Only `field eq value` joined by `and` — enough for the registry's filter
 *  templates. Anything richer belongs against a real service. */
function applyFilter(rows, filter) {
  if (!filter) return rows
  const clauses = [...filter.matchAll(/(\w+)\s+eq\s+(?:'([^']*)'|datetime'([^']*)'|([\w\-.:]+))/gi)]
  let out = rows
  for (const m of clauses) {
    const field = m[1]
    const raw = m[2] ?? m[3] ?? m[4] ?? ''
    out = field.endsWith('Date')
      ? out.filter((r) => toDate(r[field]) === toDate(raw))
      : out.filter((r) => String(r[field] ?? '') === raw)
  }
  return out
}

class MockBackend {
  constructor(fixturePath = FIXTURE) {
    this.name = 'mock'
    this.fixturePath = fixturePath
  }

  load() {
    if (!fs.existsSync(this.fixturePath)) throw new BackendError(`Fixture not found: ${this.fixturePath}`, 503)
    const body = JSON.parse(fs.readFileSync(this.fixturePath, 'utf-8'))
    let rows = extractRows(body)
    // The fixture was generated on a fixed day; shift it so "today" questions
    // keep returning rows however old the file is.
    const base = body._synthetic?.baseDate
    if (base) {
      const days = Math.round((Date.now() - new Date(`${base}T00:00:00Z`).getTime()) / 86400000)
      if (days) rows = rows.map((r) => shiftDates(r, days))
    }
    return rows
  }

  async query({ filter, select, top = 200, apiVersion = 'v2', entitySet }) {
    const started = Date.now()
    let rows = applyFilter(this.load(), filter)
    if (select) {
      const wanted = select.split(',').map((s) => s.trim()).filter(Boolean)
      rows = rows.map((r) => Object.fromEntries(wanted.map((k) => [k, r[k]])))
    }
    rows = rows.slice(0, top)
    const qs = buildQueryString({ filter, select, top, apiVersion })
    return { rows, url: `mock://${entitySet}${qs ? `?${qs}` : ''}`, statusCode: 200, elapsedMs: Date.now() - started }
  }
}

class HubBackend {
  constructor({ baseUrl, apiKey, timeoutMs = 15000 }) {
    if (!apiKey) {
      throw new BackendError(
        'No Hub API key available — set the env var named by the endpoint’s credentialRef ' +
          '(see docs/api/hub/DAY1_MANUAL_CHECKLIST.md)',
        503
      )
    }
    Object.assign(this, { baseUrl: (baseUrl || '').replace(/\/$/, ''), apiKey, timeoutMs })
    this.name = 'hub_sandbox'
  }

  async query({ servicePath, entitySet, filter, select, top = 200, apiVersion = 'v2', correlationId }) {
    const root = this.baseUrl || servicePath
    const qs = buildQueryString({ filter, select, top, apiVersion })
    const url = `${root}/${entitySet}${qs ? `?${qs}` : ''}`
    const started = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res
    try {
      res = await fetch(url, {
        headers: { APIKey: this.apiKey, Accept: 'application/json', ...(correlationId && { 'X-Correlation-ID': correlationId }) },
        signal: controller.signal,
      })
    } catch (err) {
      throw new BackendError(err.name === 'AbortError' ? `Hub timed out after ${this.timeoutMs}ms` : `Hub request failed: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw new BackendError(`Hub returned ${res.status} for ${entitySet}: ${(await res.text()).slice(0, 200)}`, res.status)
    return { rows: extractRows(await res.json()), url, statusCode: res.status, elapsedMs: Date.now() - started }
  }
}

class CpiBackend {
  constructor({ baseUrl, token, timeoutMs = 15000 }) {
    if (!baseUrl) throw new BackendError('This iFlow endpoint has no URL. Set it in the Integration console and press Test.', 503)
    Object.assign(this, { baseUrl, token, timeoutMs })
    this.name = 'cpi'
  }

  async query({ destinationName, servicePath, entitySet, filter, select, top = 200, apiVersion = 'v2', correlationId }) {
    const started = Date.now()
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token && { Authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify({
        destinationName,
        servicePath,
        entitySet,
        apiVersion,
        queryOptions: { filter, select, top },
        correlationId,
      }),
    })
    if (!res.ok) throw new BackendError(`CPI returned ${res.status}`, res.status)
    const body = await res.json()
    if (body.errorCode) throw new BackendError(`${body.errorCode}: ${body.message || ''}`)
    return {
      rows: extractRows(body.body ?? body),
      url: `${this.baseUrl}#${entitySet}`,
      statusCode: body.statusCode || res.status,
      elapsedMs: body.elapsedMs ?? Date.now() - started,
    }
  }
}

/**
 * Integration Suite iFlow over OAuth2 client credentials.
 *
 * The iFlow is an HTTP wrapper around an S/4 OData v2 service, so the response
 * is parsed as OData v2. Whether it wants the query as GET parameters or a
 * POST body is per-iFlow and therefore configuration (`httpMethod`), not an
 * assumption baked in here.
 */
class IflowBackend {
  constructor(endpoint) {
    if (!endpoint?.url) {
      throw new BackendError('This iFlow endpoint has no URL. Set it in the Integration console and press Test.', 503)
    }
    this.endpoint = endpoint
    this.name = 'iflow'
    this.timeoutMs = endpoint.timeoutMs || 15000
  }

  async #authHeader() {
    if (this.endpoint.authMode === 'oauth2_client_credentials') {
      const oauth = require('./oauth')
      return { Authorization: `Bearer ${await oauth.getToken(this.endpoint)}` }
    }
    const secret = this.endpoint.credentialRef ? process.env[this.endpoint.credentialRef] : undefined
    if (this.endpoint.authMode === 'bearer' && secret) return { Authorization: `Bearer ${secret}` }
    if (this.endpoint.authMode === 'api_key' && secret) {
      return { [this.endpoint.authHeaderName || 'APIKey']: secret }
    }
    return {}
  }

  async #send(query, headers) {
    const method = (this.endpoint.httpMethod || 'GET').toUpperCase()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      if (method === 'GET') {
        const qs = buildQueryString(query)
        const url = `${this.endpoint.url}${qs ? (this.endpoint.url.includes('?') ? '&' : '?') + qs : ''}`
        const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal })
        return { res, url }
      }
      const res = await fetch(this.endpoint.url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({
          servicePath: query.servicePath,
          entitySet: query.entitySet,
          apiVersion: query.apiVersion,
          queryOptions: { filter: query.filter, select: query.select, top: query.top },
          correlationId: query.correlationId,
        }),
        signal: controller.signal,
      })
      return { res, url: this.endpoint.url }
    } finally {
      clearTimeout(timer)
    }
  }

  async query(query) {
    const started = Date.now()
    let headers
    try {
      headers = await this.#authHeader()
    } catch (err) {
      throw new BackendError(`Authentication failed: ${err.message}`, 401)
    }

    let out
    try {
      out = await this.#send(query, headers)
    } catch (err) {
      throw new BackendError(
        err.name === 'AbortError'
          ? `iFlow did not respond within ${this.timeoutMs}ms`
          : `Could not reach the iFlow: ${err.message}`
      )
    }

    // A 401 usually means the cached token was revoked or the key rotated.
    // Drop it and try once more before surfacing an error to the user.
    if (out.res.status === 401 && this.endpoint.authMode === 'oauth2_client_credentials') {
      require('./oauth').invalidate(this.endpoint)
      headers = await this.#authHeader()
      out = await this.#send(query, headers)
    }

    if (!out.res.ok) {
      throw new BackendError(
        `iFlow returned HTTP ${out.res.status}: ${(await out.res.text()).slice(0, 200)}`,
        out.res.status
      )
    }

    let body
    try {
      body = await out.res.json()
    } catch {
      throw new BackendError('iFlow returned a non-JSON body — check what the flow emits.')
    }

    // Tolerate both a bare OData payload and the thin-CPI envelope.
    const inner = body && typeof body === 'object' && body.body ? body.body : body
    return {
      rows: extractRows(inner),
      url: out.url,
      statusCode: out.res.status,
      elapsedMs: Date.now() - started,
    }
  }
}

/**
 * Build the client an IntegrationEndpoint row describes.
 *
 * The kind is data, so pointing a business object at a customer's own iFlow is
 * a row change rather than a deploy. `url` is the endpoint the admin pasted;
 * the secret is read from the environment variable named by credentialRef and
 * never stored.
 */
function forEndpoint(endpoint) {
  const kind = endpoint?.kind || 'mock'
  const secret = endpoint?.credentialRef ? process.env[endpoint.credentialRef] : undefined
  const timeoutMs = endpoint?.timeoutMs

  if (kind === 'hub_sandbox') return new HubBackend({ baseUrl: endpoint.url, apiKey: secret, timeoutMs })
  if (kind === 'iflow') return new IflowBackend(endpoint)
  if (kind === 'cpi') return new CpiBackend({ baseUrl: endpoint.url, token: secret, timeoutMs })
  if (kind === 'odata_direct') return new HubBackend({ baseUrl: endpoint.url, apiKey: secret || 'none', timeoutMs })
  return new MockBackend()
}

module.exports = { BackendError, MockBackend, HubBackend, CpiBackend, IflowBackend, forEndpoint, extractRows, buildQueryString, toDate }
