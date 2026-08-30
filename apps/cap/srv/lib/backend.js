/**
 * The one place that talks to a backend system.
 *
 * Interchangeable modes chosen by the Connection row, so pointing a business
 * object at a real S/4 tenant instead of the sandbox is a config change rather
 * than a code change:
 *   mock         — replay the synthetic fixture, no SAP account needed
 *   hub_sandbox  — SAP Business Accelerator Hub with an API key
 *   graph        — SAP Graph over OData, one namespace in front of many services
 *   cpi / iflow  — POST the resolved query to an Integration Suite flow
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

function buildQueryString({ filter, select, top, apiVersion, expand }) {
  const parts = []
  if (filter) parts.push(`$filter=${filter}`)
  if (select) parts.push(`$select=${select}`)
  if (expand) parts.push(`$expand=${expand}`)
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

/**
 * Which fixture answers which entity set.
 *
 * Without this the mock replayed outbound deliveries for every question, so a
 * stock question offline came back with delivery rows — wrong data presented
 * as an answer, which is worse than no answer.
 */
const FIXTURES = {
  A_OutbDeliveryHeader: FIXTURE,
  A_MatlStkInAcctMod: fixture('material_stock'),
  A_MaterialDocumentItem: fixture('material_document'),
  // Graph exposes the header, the Hub exposed the item. Same fixture answers
  // both, so switching a business object between them does not break the
  // offline demo.
  A_MaterialDocumentHeader: fixture('material_document'),
  A_PhysInventoryDocHeader: fixture('physical_inventory'),
  A_PurchaseOrder: fixture('purchasing'),
}

/** Read once: flipping this per-request would let a demo half-switch mid-run. */
const DEMO_MODE = ['1', 'true', 'yes'].includes(String(process.env.FACTORYPILOT_DEMO_MODE || '').toLowerCase())

function fixture(dir) {
  return path.join(__dirname, '../../../../docs/api/hub', dir, 'sample_response.synthetic.json')
}

class MockBackend {
  constructor(fixturePath) {
    this.name = 'mock'
    this.fixturePath = fixturePath || null
  }

  /** An entity set with no fixture is refused rather than answered from the
   *  wrong file — a demo that says "I have no fixture for that" is recoverable,
   *  an answer built from another object's rows is not. */
  resolve(entitySet) {
    if (this.fixturePath) return this.fixturePath
    const found = entitySet && FIXTURES[entitySet]
    if (!found) {
      throw new BackendError(
        `No mock fixture for entity set "${entitySet || '(none)'}". ` +
          `Available: ${Object.keys(FIXTURES).join(', ')}. Run scripts/make-demo-fixtures.js to regenerate.`,
        503
      )
    }
    return found
  }

  load(entitySet) {
    const fixturePath = this.resolve(entitySet)
    if (!fs.existsSync(fixturePath)) throw new BackendError(`Fixture not found: ${fixturePath}`, 503)
    const body = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
    let rows = extractRows(body)
    // The fixture was generated on a fixed day; shift it so "today" questions
    // keep returning rows however old the file is.
    const base = body._synthetic?.baseDate
    if (base) {
      // Whole calendar days, not elapsed milliseconds rounded. Rounding the
      // elapsed time flips the shift by one day partway through the day — so
      // "how many deliveries today" answered 28 in the morning and 3 in the
      // afternoon, with nothing changed, because a different set of rows had
      // silently become "today".
      const now = new Date()
      const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const days = Math.round((startOfToday - new Date(`${base}T00:00:00Z`).getTime()) / 86400000)
      if (days) rows = rows.map((r) => shiftDates(r, days))
    }
    return rows
  }

  async query({ filter, select, top = 200, apiVersion = 'v2', entitySet }) {
    const started = Date.now()
    let rows = applyFilter(this.load(entitySet), filter)
    if (select) {
      const wanted = select.split(',').map((s) => s.trim()).filter(Boolean)
      rows = rows.map((r) => Object.fromEntries(wanted.map((k) => [k, r[k]])))
    }
    rows = rows.slice(0, top)
    const qs = buildQueryString({ filter, select, top, apiVersion })
    return { rows, url: `mock://${entitySet}${qs ? `?${qs}` : ''}`, statusCode: 200, elapsedMs: Date.now() - started }
  }
}

/**
 * SAP Graph, reached as OData.
 *
 * Graph puts one namespace in front of many S/4 services, so a business object
 * names an entity (`A_MatlStkInAcctMod`) instead of a service path plus an
 * entity set. That is the whole point of using it: registering a sixth object
 * is a row naming an entity, not a new service URL to get right.
 *
 * OData rather than the GraphQL endpoint on the same host. Both work — the
 * GraphQL one was verified against this tenant — but Graph honours `$filter`,
 * `$top` and `$expand` on the OData path, which means the query builder, the
 * filter templating and the row extraction that already serve the Hub serve
 * this too. A GraphQL client would need a schema-aware query builder, and
 * "add another entity" would stop being a row.
 */
class GraphBackend {
  constructor(endpoint) {
    if (!endpoint?.url) {
      throw new BackendError('This Graph endpoint has no URL. Set it in the Integration console and press Test.', 503)
    }
    this.endpoint = endpoint
    this.baseUrl = String(endpoint.url).replace(/\/$/, '')
    this.timeoutMs = endpoint.timeoutMs || 15000
    this.name = 'graph'
  }

  async query({ servicePath, entitySet, filter, select, top = 200, expand, correlationId }) {
    const started = Date.now()
    // The namespace travels in servicePath, the same slot the Hub uses for its
    // service path — so one column describes "where in this backend", whatever
    // the backend is.
    const ns = servicePath ? `/${String(servicePath).replace(/^\/+|\/+$/g, '')}` : ''
    const qs = buildQueryString({ filter, select, top, expand, apiVersion: 'v4' })
    const url = `${this.baseUrl}${ns}/${entitySet}${qs ? `?${qs}` : ''}`

    let out = await this.#send(url, correlationId)
    // A cached token outlives a rotated service key. Drop it and try once more
    // before telling the user their data is unreachable.
    if (out.status === 401) {
      require('./oauth').invalidate(this.endpoint)
      out = await this.#send(url, correlationId)
    }

    if (!out.ok) {
      throw new BackendError(`Graph returned HTTP ${out.status} for ${entitySet}: ${out.text.slice(0, 200)}`, out.status)
    }

    let body
    try {
      body = JSON.parse(out.text)
    } catch {
      throw new BackendError('Graph returned a non-JSON body — check the namespace and entity name.')
    }

    let rows = stripAnnotations(extractRows(body))
    // An expanded child collection arrives nested under the navigation name.
    // Flattening to one row per child restores the shape the item-level Hub
    // query had, so rowCount counts documents rather than headers and the
    // model is not asked to reason about nesting.
    if (expand) rows = flattenExpanded(rows, String(expand).split('(')[0].trim())

    return { rows, url, statusCode: out.status, elapsedMs: Date.now() - started }
  }

  async #send(url, correlationId) {
    let token
    try {
      token = await require('./oauth').getToken(this.endpoint)
    } catch (err) {
      throw new BackendError(`Graph authentication failed: ${err.message}`, 401)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(correlationId && { 'X-Correlation-ID': correlationId }),
        },
        signal: controller.signal,
      })
      // Body drained inside the timer — see HubBackend.
      return { status: res.status, ok: res.ok, text: await res.text() }
    } catch (err) {
      throw new BackendError(
        err.name === 'AbortError' ? `Graph timed out after ${this.timeoutMs}ms` : `Graph request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/** One row per expanded child, carrying its parent's fields. A parent with no
 *  children still yields its own row rather than vanishing. */
function flattenExpanded(rows, navName) {
  if (!navName) return rows
  const out = []
  for (const row of rows) {
    const children = row[navName]
    const parent = { ...row }
    delete parent[navName]
    if (Array.isArray(children) && children.length) {
      for (const child of children) out.push({ ...parent, ...child })
    } else {
      out.push(parent)
    }
  }
  return out
}

/**
 * Drop OData/Graph control annotations — `@odata.etag`, `@Graph.*` and friends.
 *
 * They are protocol bookkeeping, not warehouse data. Every one of them is sent
 * to the model as part of a row, where it costs tokens and invites the model to
 * quote an etag as though it meant something.
 */
function stripAnnotations(rows) {
  return rows.map((row) => {
    let touched = false
    const clean = {}
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('@')) { touched = true; continue }
      clean[key] = value
    }
    return touched ? clean : row
  })
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
    // One Hub endpoint serves many OData services, so the host and the service
    // path come from different places: the host is endpoint configuration, the
    // service path belongs to the business object. Using baseUrl alone sent
    // every object to whichever service the endpoint happened to name.
    const root = this.baseUrl ? `${this.baseUrl}${servicePath || ''}` : servicePath
    const qs = buildQueryString({ filter, select, top, apiVersion })
    const url = `${root}/${entitySet}${qs ? `?${qs}` : ''}`
    const started = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { APIKey: this.apiKey, Accept: 'application/json', ...(correlationId && { 'X-Correlation-ID': correlationId }) },
        signal: controller.signal,
      })
      // The body is read inside the timer, not after it. `fetch` resolves as
      // soon as the *headers* arrive — the body is still an unread stream — so
      // disarming the controller here would leave `res.json()` with nothing to
      // abort it, and a server that sends headers then stalls would hold the
      // request open indefinitely.
      if (!res.ok) throw new BackendError(`Hub returned ${res.status} for ${entitySet}: ${(await res.text()).slice(0, 200)}`, res.status)
      return { rows: extractRows(await res.json()), url, statusCode: res.status, elapsedMs: Date.now() - started }
    } catch (err) {
      if (err instanceof BackendError) throw err
      throw new BackendError(err.name === 'AbortError' ? `Hub timed out after ${this.timeoutMs}ms` : `Hub request failed: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
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
    // This is the only backend that took a timeoutMs and never used it: the
    // fetch carried no signal at all, so a CPI endpoint that stopped answering
    // would hold the request open until the gateway gave up on us.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
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
        signal: controller.signal,
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
    } catch (err) {
      if (err instanceof BackendError) throw err
      throw new BackendError(
        err.name === 'AbortError' ? `CPI timed out after ${this.timeoutMs}ms` : `CPI request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
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
      let res
      let url
      if (method === 'GET') {
        const qs = buildQueryString(query)
        url = `${this.endpoint.url}${qs ? (this.endpoint.url.includes('?') ? '&' : '?') + qs : ''}`
        res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal })
      } else {
        url = this.endpoint.url
        res = await fetch(url, {
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
      }
      // Drain the body here, not in the caller. Returning the Response and
      // clearing the timer would leave the body read unguarded, and an iFlow
      // that sends headers then stalls would never release the request.
      return { status: res.status, ok: res.ok, url, text: await res.text() }
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
    if (out.status === 401 && this.endpoint.authMode === 'oauth2_client_credentials') {
      require('./oauth').invalidate(this.endpoint)
      headers = await this.#authHeader()
      out = await this.#send(query, headers)
    }

    if (!out.ok) {
      throw new BackendError(`iFlow returned HTTP ${out.status}: ${out.text.slice(0, 200)}`, out.status)
    }

    let body
    try {
      body = JSON.parse(out.text)
    } catch {
      throw new BackendError('iFlow returned a non-JSON body — check what the flow emits.')
    }

    // Tolerate both a bare OData payload and the thin-CPI envelope.
    const inner = body && typeof body === 'object' && body.body ? body.body : body
    return {
      rows: extractRows(inner),
      url: out.url,
      statusCode: out.status,
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
  // One switch for a demo that must not depend on Integration Suite, S/4 and a
  // set of credentials all being healthy at the same moment. Every endpoint
  // answers from fixtures; nothing else in the product changes, so the agent
  // loop, quota, cache, approval and audit paths are all still exercised for
  // real. Deliberately loud, because an operator who leaves it set in
  // production would otherwise be serving fixtures to real users.
  if (DEMO_MODE) {
    if (!forEndpoint._announced) {
      console.warn(
        '[backend] FACTORYPILOT_DEMO_MODE is on — every endpoint is answering from synthetic fixtures. ' +
          'No S/4, iFlow or Hub call will be made. Unset it to reach real systems.'
      )
      forEndpoint._announced = true
    }
    return new MockBackend()
  }

  const kind = endpoint?.kind || 'mock'
  const secret = endpoint?.credentialRef ? process.env[endpoint.credentialRef] : undefined
  const timeoutMs = endpoint?.timeoutMs

  if (kind === 'graph') return new GraphBackend(endpoint)
  if (kind === 'hub_sandbox') return new HubBackend({ baseUrl: endpoint.url, apiKey: secret, timeoutMs })
  if (kind === 'iflow') return new IflowBackend(endpoint)
  if (kind === 'cpi') return new CpiBackend({ baseUrl: endpoint.url, token: secret, timeoutMs })
  if (kind === 'odata_direct') return new HubBackend({ baseUrl: endpoint.url, apiKey: secret || 'none', timeoutMs })
  return new MockBackend()
}

module.exports = { BackendError, MockBackend, HubBackend, GraphBackend, CpiBackend, IflowBackend, forEndpoint, extractRows, buildQueryString, flattenExpanded, stripAnnotations, toDate }
