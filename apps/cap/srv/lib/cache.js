const crypto = require('node:crypto')
const cds = require('@sap/cds')

/**
 * Answer cache.
 *
 * Caches the *contextualised answer*, not the raw OData rows, so a hit skips
 * both the S/4 call and the model — the model is the expensive half
 * (Documentation.docx Component 5, TDD §7.2).
 *
 * Redis when bound, an in-process map otherwise. The in-process one is correct
 * for a single instance and honest about it: with more than one replica each
 * gets its own, which costs hit-rate but never serves wrong data.
 */

let client = null
let backend = 'memory'
let connecting = null      // memoised, so concurrent first requests share one connect
let givenUp = false        // Redis has proven unusable; stop paying to find out again
let socketErrors = 0
const memory = new Map()

// A cache is an optimisation, so every Redis operation is on a short leash.
// Waiting longer than this for a cache lookup costs more than the miss does.
const OP_TIMEOUT_MS = Number(process.env.FACTORYPILOT_REDIS_OP_TIMEOUT_MS || 1500)
const CONNECT_TIMEOUT_MS = Number(process.env.FACTORYPILOT_REDIS_CONNECT_TIMEOUT_MS || 4000)
const MAX_RECONNECTS = Number(process.env.FACTORYPILOT_REDIS_MAX_RECONNECTS || 10)
const PURGE_BUDGET_MS = Number(process.env.FACTORYPILOT_REDIS_PURGE_BUDGET_MS || 20000)

/**
 * Bound an await that has no timeout of its own.
 *
 * The losing promise is not cancelled — it stays pending until the client
 * settles it — but the caller is released, which is the whole point: a stalled
 * cache must never hold a request open.
 */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Stop using Redis for the life of this instance and say so once. */
function degrade(reason) {
  if (givenUp) return
  givenUp = true
  backend = 'memory'
  const dying = client
  client = null
  cds.log('cache').warn(`redis unavailable (${reason}) — in-process cache for the rest of this instance`)
  if (dying) {
    try { dying.destroy() } catch { /* it is already gone */ }
  }
}

function redisUrlFromEnv() {
  // Bound Redis on CF arrives in VCAP_SERVICES; locally REDIS_URL is enough.
  if (process.env.REDIS_URL) return process.env.REDIS_URL
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
    for (const instances of Object.values(vcap)) {
      for (const inst of instances) {
        const c = inst.credentials || {}
        if (c.uri && /^rediss?:/.test(c.uri)) return c.uri
        if (c.hostname && c.port && c.password) {
          const scheme = c.tls || c.ssl ? 'rediss' : 'redis'
          return `${scheme}://:${encodeURIComponent(c.password)}@${c.hostname}:${c.port}`
        }
      }
    }
  } catch {
    /* malformed VCAP is not worth crashing the app over */
  }
  return null
}

async function init() {
  if (givenUp || backend === 'redis') return
  if (connecting) return connecting
  connecting = connect().finally(() => { connecting = null })
  return connecting
}

async function connect() {
  const url = redisUrlFromEnv()
  if (!url) {
    givenUp = true
    cds.log('cache').info('no Redis bound — using in-process cache (single instance only)')
    return
  }
  try {
    const redis = require('redis')
    const c = redis.createClient({
      url,
      // Without this, a command issued while the socket is down is *queued*
      // rather than rejected (see @redis/client sendCommand: it only rejects
      // when the client is closed, or offline with the queue disabled). Since
      // the reconnect strategy below keeps the client open, that queued command
      // never settles and the request awaiting it never returns — which is a
      // gateway timeout, not a cache miss. Fail fast instead.
      disableOfflineQueue: true,
      // Managed Redis drops connections it considers idle; a keepalive ping is
      // what stops "Socket closed unexpectedly" from being the normal state.
      pingInterval: 30000,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (attempts) => {
          if (attempts > MAX_RECONNECTS) {
            degrade(`gave up after ${attempts} reconnect attempts`)
            return false
          }
          return Math.min(attempts * 200, 3000)
        },
      },
    })
    // One dead socket otherwise produces an unbounded stream of identical
    // warnings, which buries everything else in the log.
    c.on('error', (err) => {
      socketErrors++
      if (socketErrors <= 3) cds.log('cache').warn('redis error:', err.message)
      else if (socketErrors === 4) cds.log('cache').warn('redis error: further socket errors suppressed')
    })
    await withTimeout(c.connect(), CONNECT_TIMEOUT_MS, 'redis connect')
    client = c
    backend = 'redis'
    socketErrors = 0
    cds.log('cache').info('cache backend: redis')
  } catch (err) {
    // A cache is an optimisation. Losing it must never take the app down, and
    // must not cost every later request another connect attempt either.
    degrade(err.message)
  }
}

/** Normalise a question so trivially different wordings share an entry. */
function normaliseQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function subjectFor(strategy, userID, roles = []) {
  if (strategy === 'GLOBAL') return 'GLOBAL'
  if (strategy === 'PER_ROLE') return 'role:' + (roles.length ? [...roles].sort().join(',') : 'none')
  return `user:${userID}`
}

/**
 * Key material is only what is known *before* the run: the question, the
 * warehouse and the subject.
 *
 * Deliberately not the objectCode — intent is resolved by the agent, so at
 * lookup time we do not have it yet. Including it would produce a write key
 * that never matches the read key, and a cache that reports a miss every time
 * while quietly filling up. The objectCode is stored in the value instead, and
 * is what purge and the TTL policy work from.
 *
 * The warehouse is in the key rather than an afterthought: the same question
 * asked against two plants is two different answers, and merging them would
 * show one site's figures to another.
 */
function buildKey({ question, warehouseID = '', strategy, userID, roles }) {
  const material = [
    normaliseQuestion(question),
    warehouseID || 'any',
    subjectFor(strategy, userID, roles),
  ].join('|')
  const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 40)
  return `fp:answer:${digest}`
}

const UNIT_SECONDS = { MINUTES: 60, HOURS: 3600, DAYS: 86400 }

function secondsUntilMidnight(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return Math.max(1, Math.floor((midnight - now) / 1000))
}

/** Does this question depend on "today"? Those must not outlive the day. */
function isDateBound(question) {
  return /\b(today|now|current|this shift|so far)\b/i.test(String(question || ''))
}

function effectiveTtl(policy, question, now = new Date()) {
  const base = Math.max(1, (policy?.ttlValue ?? 15)) * (UNIT_SECONDS[policy?.ttlUnit] ?? 60)
  if (policy?.midnightClamp !== false && isDateBound(question)) {
    return Math.min(base, secondsUntilMidnight(now))
  }
  return base
}

/**
 * Most specific policy wins: exact queryPattern, then the object, then DEFAULT.
 * Returning null means "no policy" — and no policy means no caching, so a
 * missing row can never silently start serving stale answers.
 */
async function resolvePolicy(objectCode, queryPattern = '') {
  const { CachePolicy } = cds.entities('factorypilot.cache')
  const rows = await SELECT.from(CachePolicy).where({
    isActive: true,
    objectCode: { in: [objectCode || 'DEFAULT', 'DEFAULT'] },
  })
  if (!rows.length) return null
  const exact = rows.find((r) => r.objectCode === objectCode && (r.queryPattern || '') === queryPattern)
  const perObject = rows.find((r) => r.objectCode === objectCode && !r.queryPattern)
  const fallback = rows.find((r) => r.objectCode === 'DEFAULT')
  return exact || perObject || fallback || null
}

async function get(key) {
  await init()
  if (backend === 'redis' && client) {
    try {
      const raw = await withTimeout(client.get(key), OP_TIMEOUT_MS, 'redis get')
      return raw ? JSON.parse(raw) : null
    } catch (err) {
      // A lookup that fails is a miss. Nothing about that is worth failing the
      // question over.
      cds.log('cache').warn('redis get failed:', err.message)
      return null
    }
  }
  const entry = memory.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    memory.delete(key)
    return null
  }
  return entry.value
}

async function set(key, value, ttlSeconds) {
  await init()
  const ttl = Math.max(1, ttlSeconds)
  if (backend === 'redis' && client) {
    try {
      await withTimeout(client.set(key, JSON.stringify(value), { EX: ttl }), OP_TIMEOUT_MS, 'redis set')
      return
    } catch (err) {
      // The answer is already computed and on its way back. Failing to file it
      // costs the next asker a cache miss and nothing else.
      cds.log('cache').warn('redis set failed:', err.message)
      return
    }
  }
  memory.set(key, { value, expiresAt: Date.now() + ttl * 1000 })
}

/**
 * Invalidate everything, or just the entries for one business object.
 *
 * Because objectCode is not in the key, a scoped purge reads each entry to
 * check. That is slower than a key-pattern match, but it is an occasional
 * admin action and the alternative — putting objectCode in the key — is what
 * broke lookups in the first place.
 */
async function purge(objectCode) {
  await init()
  const wanted = objectCode ? String(objectCode).toUpperCase() : null

  if (backend === 'redis' && client) {
    let removed = 0
    // A purge walks the whole keyspace, so it gets a wider budget than a
    // lookup — but still a budget. An admin waiting on a spinner is better
    // served by "removed 400 so far" than by a request that never returns.
    const deadline = Date.now() + PURGE_BUDGET_MS
    try {
      for await (const key of client.scanIterator({ MATCH: 'fp:answer:*', COUNT: 200 })) {
        if (Date.now() > deadline) {
          cds.log('cache').warn(`redis purge stopped at ${removed} entries after ${PURGE_BUDGET_MS}ms`)
          break
        }
        if (wanted) {
          const raw = await withTimeout(client.get(key), OP_TIMEOUT_MS, 'redis get')
          let entry = null
          try { entry = raw ? JSON.parse(raw) : null } catch { /* drop unreadable entries */ }
          if (entry && String(entry.objectCode || '').toUpperCase() !== wanted) continue
        }
        await withTimeout(client.del(key), OP_TIMEOUT_MS, 'redis del')
        removed++
      }
    } catch (err) {
      cds.log('cache').warn('redis purge failed:', err.message)
    }
    return removed
  }

  let removed = 0
  for (const [key, entry] of [...memory.entries()]) {
    if (!key.startsWith('fp:answer:')) continue
    if (wanted && String(entry?.value?.objectCode || '').toUpperCase() !== wanted) continue
    memory.delete(key)
    removed++
  }
  return removed
}

/** Daily counters so an admin can see whether a TTL is actually earning its keep. */
async function recordStat(objectCode, field, tokensSaved = 0) {
  const { CacheStat } = cds.entities('factorypilot.cache')
  const day = new Date().toISOString().slice(0, 10)
  try {
    const existing = await SELECT.one.from(CacheStat).where({ objectCode: objectCode || '', day })
    if (existing) {
      await UPDATE(CacheStat)
        .set({ [field]: { '+=': 1 }, tokensSaved: { '+=': tokensSaved }, lastUpdated: new Date() })
        .where({ ID: existing.ID })
    } else {
      await INSERT.into(CacheStat).entries({
        ID: cds.utils.uuid(),
        objectCode: objectCode || '',
        day,
        hits: field === 'hits' ? 1 : 0,
        misses: field === 'misses' ? 1 : 0,
        writes: field === 'writes' ? 1 : 0,
        tokensSaved,
        lastUpdated: new Date(),
      })
    }
  } catch (err) {
    // Statistics are decoration. Never fail a request over them.
    cds.log('cache').warn('cache stat write failed:', err.message)
  }
}

async function close() {
  if (client) {
    try {
      await withTimeout(client.quit(), OP_TIMEOUT_MS, 'redis quit')
    } catch {
      /* shutting down anyway */
    }
    client = null
  }
  backend = 'memory'
  connecting = null
  givenUp = false
  socketErrors = 0
  memory.clear()
}

module.exports = {
  init, get, set, purge, resolvePolicy, buildKey, effectiveTtl,
  normaliseQuestion, subjectFor, secondsUntilMidnight, isDateBound, recordStat, close,
  get backend() { return backend },
  _memory: memory,
  /**
   * Test seam. Standing in a client that hangs or rejects is the only way to
   * exercise the behaviour this module exists for — surviving a Redis that has
   * stopped answering — without a real broken Redis to hand.
   */
  _injectClient(fake) {
    client = fake
    backend = fake ? 'redis' : 'memory'
    givenUp = false
  },
}
