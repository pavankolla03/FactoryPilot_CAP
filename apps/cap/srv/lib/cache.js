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
const memory = new Map()

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
  if (client !== null || backend === 'redis') return
  const url = redisUrlFromEnv()
  if (!url) {
    cds.log('cache').info('no Redis bound — using in-process cache (single instance only)')
    return
  }
  try {
    const redis = require('redis')
    client = redis.createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 200, 3000) } })
    client.on('error', (err) => cds.log('cache').warn('redis error:', err.message))
    await client.connect()
    backend = 'redis'
    cds.log('cache').info('cache backend: redis')
  } catch (err) {
    // A cache is an optimisation. Losing it must never take the app down.
    client = null
    cds.log('cache').warn(`redis unavailable (${err.message}) — falling back to in-process cache`)
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
      const raw = await client.get(key)
      return raw ? JSON.parse(raw) : null
    } catch (err) {
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
      await client.set(key, JSON.stringify(value), { EX: ttl })
      return
    } catch (err) {
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
    try {
      for await (const key of client.scanIterator({ MATCH: 'fp:answer:*', COUNT: 200 })) {
        if (wanted) {
          const raw = await client.get(key)
          let entry = null
          try { entry = raw ? JSON.parse(raw) : null } catch { /* drop unreadable entries */ }
          if (entry && String(entry.objectCode || '').toUpperCase() !== wanted) continue
        }
        await client.del(key)
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
      await client.quit()
    } catch {
      /* shutting down anyway */
    }
    client = null
    backend = 'memory'
  }
  memory.clear()
}

module.exports = {
  init, get, set, purge, resolvePolicy, buildKey, effectiveTtl,
  normaliseQuestion, subjectFor, secondsUntilMidnight, isDateBound, recordStat, close,
  get backend() { return backend },
  _memory: memory,
}
