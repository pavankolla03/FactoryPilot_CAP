const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { GET, POST } = cds.test(PROJECT).in(PROJECT)

/**
 * Create a row the way the Admin screens do: POST a draft, then activate it.
 *
 * Draft-enabled entities accept an incomplete POST on purpose — that is what a
 * draft is for, and it is why the Admin UI can offer a half-filled form without
 * the server refusing every keystroke. The rules that used to reject a bad POST
 * now run at activation, so a test that only POSTs proves nothing about them.
 */
async function createActive(collection, service, payload, auth) {
  const { data: draft } = await POST(collection, payload, auth)
  return POST(`${collection}(ID=${draft.ID},IsActiveEntity=false)/${service}.draftActivate`, {}, auth)
}


const cache = require('../srv/lib/cache')

const ADMIN = { auth: { username: 'admin', password: 'admin' } }
const BOB = { auth: { username: 'bob', password: 'bob' } }
const BUSINESS = ['BusinessUser', 'InsightsQuery']

// ---------------------------------------------------------------------------
// Key construction — what shares an entry and what must not
// ---------------------------------------------------------------------------

describe('cache keys', () => {
  const base = { question: 'How many deliveries today?', warehouseID: '1000', strategy: 'PER_USER', userID: 'bob', roles: [] }

  test('wording differences that mean the same thing share an entry', () => {
    const a = cache.buildKey(base)
    const b = cache.buildKey({ ...base, question: '  How many   deliveries  TODAY?? ' })
    assert.equal(a, b)
  })

  test('a different warehouse is a different entry', () => {
    // The failure this prevents is not a slow response, it is one plant being
    // shown another plant's figures.
    assert.notEqual(cache.buildKey(base), cache.buildKey({ ...base, warehouseID: '1010' }))
  })

  test('PER_USER does not leak between users', () => {
    assert.notEqual(cache.buildKey(base), cache.buildKey({ ...base, userID: 'sue' }))
  })

  test('GLOBAL is shared across users by design', () => {
    const g = { ...base, strategy: 'GLOBAL' }
    assert.equal(cache.buildKey(g), cache.buildKey({ ...g, userID: 'sue' }))
  })

  test('PER_ROLE ignores role order', () => {
    const r = { ...base, strategy: 'PER_ROLE' }
    assert.equal(
      cache.buildKey({ ...r, userID: 'bob', roles: ['B', 'A'] }),
      cache.buildKey({ ...r, userID: 'sue', roles: ['A', 'B'] })
    )
  })

  test('a different question is a different entry', () => {
    assert.notEqual(cache.buildKey(base), cache.buildKey({ ...base, question: 'how many purchase orders?' }))
  })
})

// ---------------------------------------------------------------------------
// TTL and the midnight clamp
// ---------------------------------------------------------------------------

describe('ttl', () => {
  const policy = { ttlValue: 15, ttlUnit: 'MINUTES', midnightClamp: true }

  test('converts units', () => {
    assert.equal(cache.effectiveTtl({ ttlValue: 2, ttlUnit: 'HOURS', midnightClamp: false }, 'x'), 7200)
    assert.equal(cache.effectiveTtl({ ttlValue: 1, ttlUnit: 'DAYS', midnightClamp: false }, 'x'), 86400)
  })

  test('a "today" answer does not outlive today', () => {
    // 23:52 with a 15-minute policy must expire in 8 minutes, not 15 —
    // otherwise it reports yesterday's deliveries as this morning's.
    const late = new Date(2026, 7, 9, 23, 52, 0)
    assert.equal(cache.effectiveTtl(policy, 'How many deliveries today?', late), 8 * 60)
  })

  test('a question with no date sense keeps the full TTL', () => {
    const late = new Date(2026, 7, 9, 23, 52, 0)
    assert.equal(cache.effectiveTtl(policy, 'list the shipping points', late), 15 * 60)
  })

  test('the clamp can be switched off per policy', () => {
    const late = new Date(2026, 7, 9, 23, 52, 0)
    assert.equal(cache.effectiveTtl({ ...policy, midnightClamp: false }, 'deliveries today', late), 15 * 60)
  })

  test('date-bound detection', () => {
    assert.equal(cache.isDateBound('how many today'), true)
    assert.equal(cache.isDateBound('what is current stock'), true)
    assert.equal(cache.isDateBound('list all shipping points'), false)
  })
})

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

describe('cache store', () => {
  beforeEach(async () => { await cache.purge() })

  test('round-trips a value', async () => {
    await cache.set('fp:answer:k1', { answer: 'hello' }, 60)
    assert.deepEqual(await cache.get('fp:answer:k1'), { answer: 'hello' })
  })

  test('an expired entry is a miss, not stale data', async () => {
    await cache.set('fp:answer:k2', { answer: 'old' }, 1)
    cache._memory.get('fp:answer:k2').expiresAt = Date.now() - 1
    assert.equal(await cache.get('fp:answer:k2'), null)
  })

  test('purge scoped to one object leaves others alone', async () => {
    // objectCode lives in the value, not the key, so purge reads to decide.
    await cache.set('fp:answer:aaa', { objectCode: 'DELIVERY', answer: 'd' }, 60)
    await cache.set('fp:answer:bbb', { objectCode: 'SALES', answer: 's' }, 60)
    const removed = await cache.purge('DELIVERY')
    assert.equal(removed, 1)
    assert.equal(await cache.get('fp:answer:aaa'), null)
    assert.equal((await cache.get('fp:answer:bbb')).answer, 's')
  })

  test('a miss returns null rather than throwing', async () => {
    assert.equal(await cache.get('fp:answer:nothing:here'), null)
  })
})

describe('a Redis that stopped answering is a miss, never a hang', () => {
  // This is what produced "HTTP 504" on every question. node-redis only
  // rejects a command when the client is *closed*; while it is reconnecting it
  // queues instead, and a reconnect strategy that never gives up keeps it
  // reconnecting forever. The queued command never settled, so the request
  // awaiting it never returned and the approuter timed the user out.
  afterEach(async () => {
    cache._injectClient(null)
    await cache.purge()
  })

  test('a get that never settles gives up and reports a miss', async () => {
    cache._injectClient({ get: () => new Promise(() => {}) })   // never resolves
    const startedAt = Date.now()
    const value = await cache.get('fp:answer:hangs')
    const elapsed = Date.now() - startedAt
    assert.equal(value, null, 'a stalled lookup is a miss')
    assert.ok(elapsed < 5000, `should give up quickly, took ${elapsed}ms`)
  })

  test('a set that never settles does not hold the answer back', async () => {
    cache._injectClient({ set: () => new Promise(() => {}) })
    const startedAt = Date.now()
    await cache.set('fp:answer:hangs', { answer: 'x' }, 60)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 5000, `should give up quickly, took ${elapsed}ms`)
  })

  test('a rejecting client is a miss, not an exception', async () => {
    // What disableOfflineQueue produces once the socket is down.
    cache._injectClient({
      get: async () => { throw new Error('The client is offline') },
      set: async () => { throw new Error('The client is offline') },
    })
    assert.equal(await cache.get('fp:answer:offline'), null)
    await cache.set('fp:answer:offline', { answer: 'x' }, 60)   // must not throw
  })
})

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

describe('policy resolution', () => {
  test('an object-specific policy beats DEFAULT', async () => {
    const p = await cache.resolvePolicy('DELIVERY', '')
    assert.equal(p.objectCode, 'DELIVERY')
    assert.equal(p.ttlValue, 10)
  })

  test('an unknown object falls back to DEFAULT', async () => {
    const p = await cache.resolvePolicy('SOMETHING_ELSE', '')
    assert.equal(p.objectCode, 'DEFAULT')
  })

  test('an inactive policy is not used', async () => {
    // PURCHASING is seeded inactive, so it must resolve to DEFAULT rather than
    // silently caching for the 2 hours its own row specifies.
    const p = await cache.resolvePolicy('PURCHASING', '')
    assert.equal(p.objectCode, 'DEFAULT')
  })
})

// ---------------------------------------------------------------------------
// CacheService
// ---------------------------------------------------------------------------

describe('CacheService', () => {
  test('serves the seeded policies', async () => {
    const { data } = await GET('/odata/cache/CachePolicies?$select=objectCode,ttlValue', ADMIN)
    assert.ok(data.value.some((r) => r.objectCode === 'DELIVERY'))
  })

  test('a business user cannot change cache policy', async () => {
    await assert.rejects(
      () => POST('/odata/cache/CachePolicies', { objectCode: 'X', ttlValue: 5 }, BOB),
      (err) => err.response?.status === 403
    )
  })

  test('GLOBAL requires a written justification', async () => {
    // GLOBAL shares one answer across every user. On a warehouse-scoped object
    // that is a data-visibility decision, so it may not be set silently.
    await assert.rejects(
      () => createActive('/odata/cache/CachePolicies', 'CacheService', { objectCode: 'GX', cacheKeyStrategy: 'GLOBAL' }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('a zero TTL is refused with a usable message', async () => {
    await assert.rejects(
      () => createActive('/odata/cache/CachePolicies', 'CacheService', { objectCode: 'ZT', ttlValue: 0 }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('health reports the live backend', async () => {
    const { data } = await GET('/odata/cache/health()', ADMIN)
    assert.ok(['memory', 'redis'].includes(data.backend))
    assert.ok(data.policiesActive >= 1)
  })
})

// ---------------------------------------------------------------------------
// End to end — the behaviour that was missing entirely before
// ---------------------------------------------------------------------------

describe('caching in the request path', () => {
  beforeEach(async () => {
    await cache.purge()
    await cds.db.run(DELETE.from('factorypilot.token.Consumption').where({ userID: 'bob' }))
  })

  const ask = (question) =>
    POST('/insights/ask', { question, warehouseID: '1000' }, BOB)

  test('the second identical question is served from cache', async () => {
    const first = await ask('How many deliveries today in warehouse 1000?')
    assert.equal(first.data.metadata.cacheResult, 'MISS')
    assert.ok(first.data.metadata.tokensUsed > 0)

    const second = await ask('How many deliveries today in warehouse 1000?')
    assert.equal(second.data.metadata.cacheResult, 'HIT')
    assert.equal(second.data.answer, first.data.answer)
    assert.equal(second.data.metadata.tokensUsed, 0, 'a hit must spend no model tokens')
  })

  test('a different warehouse is not served from another warehouse’s cache', async () => {
    await ask('How many deliveries today?')
    const other = await POST('/insights/ask', { question: 'How many deliveries today?', warehouseID: '1010' }, BOB)
    assert.equal(other.data.metadata.cacheResult, 'MISS')
  })

  test('quota is still charged on a cache hit', async () => {
    // This is why the cache is read after the quota gate: if a hit were free,
    // anyone over their limit could keep asking the same question forever.
    await ask('How many deliveries today in warehouse 1000?')
    const before = await GET('/odata/token/myUsage()', BOB)
    await ask('How many deliveries today in warehouse 1000?')
    const after = await GET('/odata/token/myUsage()', BOB)
    assert.equal(after.data.usedDay, before.data.usedDay + 1)
  })

  test('a cache hit still writes its own audit row', async () => {
    const before = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    await ask('How many deliveries today in warehouse 1000?')
    await ask('How many deliveries today in warehouse 1000?')
    const after = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    assert.equal(Number(after.data), Number(before.data) + 2)

    const { data: logs } = await GET(
      "/odata/audit/SessionLogs?$filter=cacheResult eq 'HIT'&$top=1", ADMIN
    )
    assert.ok(logs.value.length >= 1, 'the hit must be visible in the audit trail')
  })

  test('a proposed write is never served from cache', async () => {
    // Replaying a write from cache would hand a second person a confirmation
    // card for an action that was already approved and executed.
    const first = await POST('/insights/ask', { question: 'Move 15 units of P123 to shipping in warehouse 1000', warehouseID: '1000' }, BOB)
    assert.equal(first.data.status, 'AWAITING_APPROVAL')

    const second = await POST('/insights/ask', { question: 'Move 15 units of P123 to shipping in warehouse 1000', warehouseID: '1000' }, BOB)
    assert.equal(second.data.status, 'AWAITING_APPROVAL')
    assert.equal(second.data.metadata.cacheResult, 'MISS')
    assert.notEqual(
      second.data.pendingAction.actionID,
      first.data.pendingAction.actionID,
      'each proposal must be its own action'
    )
  })

  test('purging forces the next question back to the source', async () => {
    await ask('How many deliveries today in warehouse 1000?')
    const hit = await ask('How many deliveries today in warehouse 1000?')
    assert.equal(hit.data.metadata.cacheResult, 'HIT')

    await POST('/odata/cache/purge', { objectCode: 'DELIVERY' }, ADMIN)

    const afterPurge = await ask('How many deliveries today in warehouse 1000?')
    assert.equal(afterPurge.data.metadata.cacheResult, 'MISS')
  })

  test('hits and misses are counted for the dashboard', async () => {
    await ask('How many deliveries today in warehouse 1000?')
    await ask('How many deliveries today in warehouse 1000?')
    const { data } = await GET('/odata/cache/EffectivenessByObject', ADMIN)
    const total = data.value.reduce((n, r) => n + (r.hits || 0) + (r.misses || 0), 0)
    assert.ok(total >= 2, 'lookups should be recorded')
  })
})

/**
 * Where the cache decides Redis *is*.
 *
 * This resolver is the difference between a working shared cache and a silent
 * degrade to in-process, and every branch here corresponds to a real hosting
 * arrangement: a bound Cloud Foundry service, and a client running their own
 * Redis on AWS, GCP or Azure and handing us a URL. The CA branch exists
 * because managed Redis usually presents a private certificate, and when node
 * cannot verify it the socket simply never opens — which reads as a connect
 * timeout and sends you hunting for a network problem that is not there.
 */
describe('resolving where Redis is', () => {
  const OWNED = ['REDIS_URL', 'VCAP_SERVICES', 'REDIS_CA_CERT']
  let saved
  beforeEach(() => {
    saved = Object.fromEntries(OWNED.map((k) => [k, process.env[k]]))
    for (const k of OWNED) delete process.env[k]
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('nothing bound resolves to nothing, rather than a bad guess', () => {
    assert.equal(cache.resolveRedis(), null)
  })

  test('REDIS_URL is how a client points us at their own cloud', () => {
    process.env.REDIS_URL = 'rediss://:pw@my-cache.aws.example:6380'
    const t = cache.resolveRedis()
    assert.equal(t.host, 'my-cache.aws.example')
    assert.equal(t.port, '6380')
    assert.equal(t.tls, true)
    assert.equal(t.source, 'REDIS_URL')
  })

  test('a bound Cloud Foundry service is found by its credentials', () => {
    process.env.VCAP_SERVICES = JSON.stringify({
      'redis-cache': [{ credentials: { uri: 'rediss://:pw@bound.example:6380' } }],
    })
    const t = cache.resolveRedis()
    assert.equal(t.host, 'bound.example')
    assert.equal(t.source, 'VCAP_SERVICES.redis-cache')
  })

  test('a binding without a uri is assembled from its parts, TLS included', () => {
    process.env.VCAP_SERVICES = JSON.stringify({
      redis: [{ credentials: { hostname: 'h.example', port: 6380, password: 'p w/special', tls: true } }],
    })
    const t = cache.resolveRedis()
    assert.equal(t.tls, true)
    assert.equal(t.host, 'h.example')
    // A password with characters that mean something in a URL must survive.
    assert.ok(t.url.includes(encodeURIComponent('p w/special')))
  })

  test("a binding's CA certificate is picked up so TLS can actually verify", () => {
    process.env.VCAP_SERVICES = JSON.stringify({
      redis: [{ credentials: { uri: 'rediss://:pw@h.example:6380', ca_certificate: '-----BEGIN CERTIFICATE-----x' } }],
    })
    assert.match(cache.resolveRedis().ca, /BEGIN CERTIFICATE/)
  })

  test('REDIS_CA_CERT supplies the CA when the binding carries none', () => {
    process.env.REDIS_URL = 'rediss://:pw@h.example:6380'
    process.env.REDIS_CA_CERT = '-----BEGIN CERTIFICATE-----y'
    assert.match(cache.resolveRedis().ca, /BEGIN CERTIFICATE/)
  })

  test('an explicit REDIS_URL wins over a bound service', () => {
    process.env.REDIS_URL = 'redis://chosen.example:6379'
    process.env.VCAP_SERVICES = JSON.stringify({ redis: [{ credentials: { uri: 'rediss://:pw@bound.example:6380' } }] })
    assert.equal(cache.resolveRedis().host, 'chosen.example')
  })

  test('malformed VCAP is ignored rather than thrown', () => {
    process.env.VCAP_SERVICES = '{not json'
    assert.equal(cache.resolveRedis(), null)
  })
})
