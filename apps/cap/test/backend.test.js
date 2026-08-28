/**
 * The backend adapters — the code that runs the moment a real S/4 system is
 * connected, and the only part of the request path that talks to anything
 * outside this process.
 *
 * It had no tests at all. Everything demonstrable today goes through
 * MockBackend, so a break in the Hub, CPI or iFlow adapters would have been
 * invisible until a customer pointed the product at their own system — which
 * is exactly the moment it must not be discovered.
 *
 * No network: fetch is stubbed per test and every stub asserts the request that
 * was actually made, because the request shape is what these adapters are for.
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const backend = require('../srv/lib/backend')
const oauth = require('../srv/lib/oauth')
const { BackendError, extractRows, buildQueryString, toDate, forEndpoint } = backend

// --- fetch stubbing ---------------------------------------------------------

let realFetch
let calls

beforeEach(() => {
  realFetch = global.fetch
  calls = []
})

afterEach(() => {
  global.fetch = realFetch
  oauth.clear()
})

/** Record every request, and reply with the queued responses in order. */
function stubFetch(...responses) {
  let i = 0
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const r = responses[Math.min(i++, responses.length - 1)]
    if (typeof r === 'function') return r()
    return r
  }
}

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

const text = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => { throw new SyntaxError('not json') },
  text: async () => body,
})

const V2 = { d: { results: [{ Material: 'P123', Plant: '1000' }] } }

// ---------------------------------------------------------------------------

describe('OData payload shapes', () => {
  test('reads v2, v4 and refuses to invent rows from anything else', () => {
    // v2 nests under d.results, v4 is a flat value array. Getting this wrong
    // yields zero rows and an answer of "no records" for data that is there.
    assert.deepEqual(extractRows({ d: { results: [{ a: 1 }] } }), [{ a: 1 }])
    assert.deepEqual(extractRows({ d: [{ a: 1 }] }), [{ a: 1 }])
    assert.deepEqual(extractRows({ value: [{ a: 1 }] }), [{ a: 1 }])
    for (const junk of [null, undefined, 'text', 42, {}, { d: { results: 'nope' } }]) {
      assert.deepEqual(extractRows(junk), [], `${JSON.stringify(junk)} must yield no rows`)
    }
  })

  test('v2 asks for JSON explicitly; v4 does not need to', () => {
    // Without $format=json a v2 service answers XML, which parses to no rows.
    assert.match(buildQueryString({ filter: "A eq '1'", top: 5, apiVersion: 'v2' }), /\$format=json/)
    assert.doesNotMatch(buildQueryString({ top: 5, apiVersion: 'v4' }), /\$format/)
    assert.equal(buildQueryString({}), '')
  })

  test('dates arrive as /Date(ticks)/ or ISO and normalise to one form', () => {
    assert.equal(toDate('/Date(1755561600000)/'), '2025-08-19')
    assert.equal(toDate('2026-08-19T00:00:00Z'), '2026-08-19')
    assert.equal(toDate(null), '')
  })
})

describe('forEndpoint routing', () => {
  test('each kind reaches its own adapter', () => {
    // The secret is read from the environment variable *named* by
    // credentialRef — the value never appears in the endpoint row.
    process.env.HUBKEY = 'k-from-env'
    try {
      assert.equal(forEndpoint({ kind: 'hub_sandbox', url: 'https://h', credentialRef: 'HUBKEY' }).name, 'hub_sandbox')
      assert.equal(forEndpoint({ kind: 'cpi', url: 'https://c' }).name, 'cpi')
      assert.equal(forEndpoint({ kind: 'iflow', url: 'https://i' }).name, 'iflow')
      assert.equal(forEndpoint({ kind: 'odata_direct', url: 'https://o' }).name, 'hub_sandbox')
      // An unknown or absent kind must not fall through to a live call.
      assert.equal(forEndpoint({ kind: 'nonsense' }).name, 'mock')
      assert.equal(forEndpoint(null).name, 'mock')
    } finally {
      delete process.env.HUBKEY
    }
  })

  test('a Hub endpoint whose key is not set fails loudly at selection', () => {
    // Better here, naming the missing variable, than as an unauthenticated
    // call that comes back 401 and reads like the Hub is down.
    delete process.env.MISSINGKEY
    assert.throws(
      () => forEndpoint({ kind: 'hub_sandbox', url: 'https://h', credentialRef: 'MISSINGKEY' }),
      (err) => err.statusCode === 503 && /No Hub API key/.test(err.message)
    )
  })

  test('demo mode overrides every kind, including a live one', () => {
    // The point of the switch is that a demo cannot accidentally call a
    // customer system because one row still says "iflow".
    const saved = process.env.FACTORYPILOT_DEMO_MODE
    process.env.FACTORYPILOT_DEMO_MODE = '1'
    try {
      delete require.cache[require.resolve('../srv/lib/backend')]
      const fresh = require('../srv/lib/backend')
      assert.equal(fresh.forEndpoint({ kind: 'iflow', url: 'https://real.example' }).name, 'mock')
    } finally {
      if (saved === undefined) delete process.env.FACTORYPILOT_DEMO_MODE
      else process.env.FACTORYPILOT_DEMO_MODE = saved
      delete require.cache[require.resolve('../srv/lib/backend')]
      require('../srv/lib/backend')
    }
  })
})

describe('MockBackend fixture routing', () => {
  test('each entity set is answered from its own fixture', async () => {
    const mock = new backend.MockBackend()
    const stock = await mock.query({ entitySet: 'A_MatlStkInAcctMod' })
    const orders = await mock.query({ entitySet: 'A_PurchaseOrder' })

    assert.ok(stock.rows.length, 'material stock fixture must have rows')
    assert.ok('MatlStkQtyInMatlBaseUnitUnrestricted' in stock.rows[0])
    assert.ok('PurchaseOrder' in orders.rows[0])
  })

  test('an entity set with no fixture is refused, not answered from another', async () => {
    // Replaying deliveries for a stock question is wrong data presented as an
    // answer, which is worse than no answer.
    const mock = new backend.MockBackend()
    await assert.rejects(
      () => mock.query({ entitySet: 'A_SomethingNobodySeeded' }),
      (err) => err instanceof BackendError && /No mock fixture/.test(err.message)
    )
  })

  test('a filter actually narrows the rows', async () => {
    const mock = new backend.MockBackend()
    const all = await mock.query({ entitySet: 'A_MatlStkInAcctMod' })
    const one = await mock.query({ entitySet: 'A_MatlStkInAcctMod', filter: "Material eq 'P123'" })
    assert.ok(one.rows.length < all.rows.length, 'the filter must remove rows')
    assert.ok(one.rows.every((r) => r.Material === 'P123'))
  })
})

describe('HubBackend', () => {
  test('refuses to construct without a key rather than calling unauthenticated', () => {
    assert.throws(
      () => new backend.HubBackend({ baseUrl: 'https://sandbox.api.sap.com/x' }),
      (err) => err instanceof BackendError && err.statusCode === 503
    )
  })

  test('builds the URL and sends the APIKey header the Hub requires', async () => {
    stubFetch(json(V2))
    const hub = new backend.HubBackend({ baseUrl: 'https://sandbox.api.sap.com/s4/API_X/', apiKey: 'k-123' })
    const out = await hub.query({
      entitySet: 'A_MatlStkInAcctMod',
      filter: "Plant eq '1000'",
      select: 'Material',
      apiVersion: 'v2',
      correlationId: 'corr-1',
    })

    assert.equal(out.rows.length, 1)
    // The trailing slash on baseUrl must not produce a double slash.
    assert.match(calls[0].url, /^https:\/\/sandbox\.api\.sap\.com\/s4\/API_X\/A_MatlStkInAcctMod\?/)
    assert.match(calls[0].url, /\$filter=Plant eq '1000'/)
    assert.equal(calls[0].init.headers.APIKey, 'k-123', 'the Hub rejects anything else')
    assert.equal(calls[0].init.headers['X-Correlation-ID'], 'corr-1')
  })

  test('an HTTP error carries the status through, not a generic failure', async () => {
    // The status is what distinguishes a bad key (403) from a wrong path (404),
    // and it is what the Integration console shows an admin.
    stubFetch(text('quota exceeded', 429))
    const hub = new backend.HubBackend({ baseUrl: 'https://h', apiKey: 'k' })
    await assert.rejects(
      () => hub.query({ entitySet: 'A_X' }),
      (err) => err.statusCode === 429 && /Hub returned 429/.test(err.message)
    )
  })

  test('a hanging Hub aborts rather than holding the request open', async () => {
    global.fetch = async (_u, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
        })
      })
    const hub = new backend.HubBackend({ baseUrl: 'https://h', apiKey: 'k', timeoutMs: 40 })
    await assert.rejects(() => hub.query({ entitySet: 'A_X' }), /timed out after 40ms/)
  })
})

describe('CpiBackend', () => {
  test('refuses an endpoint with no URL', () => {
    assert.throws(() => new backend.CpiBackend({}), (err) => err.statusCode === 503)
  })

  test('posts the query as a body the thin iFlow contract understands', async () => {
    stubFetch(json({ statusCode: 200, body: V2 }))
    const cpi = new backend.CpiBackend({ baseUrl: 'https://cpi/http/s4/odata/query', token: 't-9' })
    const out = await cpi.query({
      destinationName: 'S4_HUB',
      servicePath: '/sap/opu/odata/sap/API_X',
      entitySet: 'A_Y',
      filter: "A eq '1'",
      apiVersion: 'v2',
    })

    assert.equal(out.rows.length, 1)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t-9')
    const sent = JSON.parse(calls[0].init.body)
    assert.equal(sent.destinationName, 'S4_HUB')
    assert.equal(sent.queryOptions.filter, "A eq '1'")
  })

  test('an error reported inside a 200 body is still an error', async () => {
    // The iFlow answers 200 with an errorCode when S/4 refuses it. Treating
    // that as success produces an answer of "no records" for a failed call.
    stubFetch(json({ errorCode: 'S4_UNAUTHORISED', message: 'destination rejected' }))
    const cpi = new backend.CpiBackend({ baseUrl: 'https://cpi' })
    await assert.rejects(() => cpi.query({ entitySet: 'A_Y' }), /S4_UNAUTHORISED/)
  })
})

describe('IflowBackend', () => {
  const OAUTH_ENDPOINT = {
    ID: 'ep-1',
    url: 'https://tenant.it-cpi.example/http/material_stock',
    authMode: 'oauth2_client_credentials',
    tokenUrl: 'https://tenant.authentication.example/oauth/token',
    credentialRef: 'TESTCPI',
    httpMethod: 'GET',
  }

  test('missing credentials surface as an authentication failure, naming what to set', async () => {
    delete process.env.TESTCPI_CLIENT_ID
    delete process.env.TESTCPI_CLIENT_SECRET
    const iflow = new backend.IflowBackend(OAUTH_ENDPOINT)
    await assert.rejects(
      () => iflow.query({ entitySet: 'A_X' }),
      (err) => err.statusCode === 401 && /TESTCPI_CLIENT_ID/.test(err.message)
    )
  })

  test('a GET carries the query in the URL and the bearer token in the header', async () => {
    process.env.TESTCPI_CLIENT_ID = 'id'
    process.env.TESTCPI_CLIENT_SECRET = 'secret'
    stubFetch(
      json({ access_token: 'tok-1', expires_in: 3600 }), // token request
      json(V2)                                            // the iFlow itself
    )
    try {
      const out = await new backend.IflowBackend(OAUTH_ENDPOINT).query({
        entitySet: 'A_MatlStkInAcctMod',
        filter: "Plant eq '1000'",
        apiVersion: 'v2',
      })
      assert.equal(out.rows.length, 1)
      assert.equal(calls[0].url, OAUTH_ENDPOINT.tokenUrl, 'the token comes first')
      assert.match(calls[1].url, /\?\$filter=Plant eq '1000'/)
      assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1')
    } finally {
      delete process.env.TESTCPI_CLIENT_ID
      delete process.env.TESTCPI_CLIENT_SECRET
    }
  })

  test('a 401 drops the cached token and retries once', async () => {
    // A token cached across a credential rotation is inside its stated expiry
    // and still refused; without the retry every call fails until restart.
    process.env.TESTCPI_CLIENT_ID = 'id'
    process.env.TESTCPI_CLIENT_SECRET = 'secret'
    const queue = [
      json({ access_token: 'stale', expires_in: 3600 }),
      json({ message: 'unauthorized' }, 401),
      json({ access_token: 'fresh', expires_in: 3600 }),
      json(V2),
    ]
    let i = 0
    global.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return queue[i++] }
    try {
      const out = await new backend.IflowBackend(OAUTH_ENDPOINT).query({ entitySet: 'A_X' })
      assert.equal(out.rows.length, 1)
      const bearers = calls.filter((c) => c.init.headers?.Authorization).map((c) => c.init.headers.Authorization)
      assert.deepEqual(bearers, ['Bearer stale', 'Bearer fresh'], 'the retry must not reuse the rejected token')
    } finally {
      delete process.env.TESTCPI_CLIENT_ID
      delete process.env.TESTCPI_CLIENT_SECRET
    }
  })

  test('an HTML error page is reported as such, not parsed into zero rows', async () => {
    // A misconfigured iFlow commonly answers 200 with an HTML login page.
    // Parsing that to [] would report "no records matched".
    stubFetch(text('<html><body>Sign in</body></html>'))
    const iflow = new backend.IflowBackend({ ...OAUTH_ENDPOINT, authMode: 'none', credentialRef: null })
    await assert.rejects(() => iflow.query({ entitySet: 'A_X' }), /non-JSON body/)
  })

  test('an api_key endpoint sends the header name the flow expects', async () => {
    process.env.FLOWKEY = 'abc123'
    stubFetch(json(V2))
    try {
      await new backend.IflowBackend({
        url: 'https://flow.example/x',
        authMode: 'api_key',
        authHeaderName: 'X-Custom-Key',
        credentialRef: 'FLOWKEY',
      }).query({ entitySet: 'A_X' })
      assert.equal(calls[0].init.headers['X-Custom-Key'], 'abc123')
    } finally {
      delete process.env.FLOWKEY
    }
  })
})
