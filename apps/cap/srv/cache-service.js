const cds = require('@sap/cds')
const cache = require('./lib/cache')

const UNITS = ['MINUTES', 'HOURS', 'DAYS']
const STRATEGIES = ['PER_USER', 'PER_ROLE', 'GLOBAL']

module.exports = cds.service.impl(function () {
  const { CachePolicies, CacheStats } = this.entities

  // CREATE, UPDATE *and* SAVE. Once an entity is draft-enabled a direct POST
  // creates a draft rather than a row, so a rule registered only on CREATE sees
  // a half-filled draft and lets the finished record through — the screen would
  // happily save a GLOBAL policy with no justification. SAVE is the moment a
  // draft becomes real, and it is where the finished record is checked.
  this.before(['CREATE', 'UPDATE', 'SAVE'], CachePolicies, (req) => {
    const d = req.data
    if (d.ttlUnit && !UNITS.includes(d.ttlUnit)) {
      req.error(400, `ttlUnit must be one of ${UNITS.join(', ')}`, 'ttlUnit')
    }
    if (d.cacheKeyStrategy && !STRATEGIES.includes(d.cacheKeyStrategy)) {
      req.error(400, `cacheKeyStrategy must be one of ${STRATEGIES.join(', ')}`, 'cacheKeyStrategy')
    }
    if (d.ttlValue != null && d.ttlValue < 1) {
      req.error(400, 'ttlValue must be at least 1 — to disable caching, clear Caching Enabled', 'ttlValue')
    }
    // GLOBAL shares one answer across every user. On a warehouse-scoped object
    // that means showing one plant's numbers to another, so it has to be a
    // deliberate choice rather than a default someone inherited.
    if (d.cacheKeyStrategy === 'GLOBAL' && !d.description) {
      req.error(
        400,
        'GLOBAL shares one cached answer across all users. Record why that is safe for this object in Description.',
        'cacheKeyStrategy'
      )
    }
    if (d.objectCode) d.objectCode = d.objectCode.toUpperCase()
  })

  this.after('READ', CacheStats, (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (!row) continue
      const looks = (row.hits || 0) + (row.misses || 0)
      row.hitRatio = looks ? Math.round(((row.hits || 0) / looks) * 10000) / 100 : 0
    }
  })

  this.on('purge', async (req) => {
    const objectCode = req.data.objectCode ? req.data.objectCode.toUpperCase() : null
    const removed = await cache.purge(objectCode)
    return { removed, objectCode: objectCode || 'ALL', backend: cache.backend }
  })

  this.on('health', async () => {
    await cache.init()
    const { CachePolicy, CacheStat } = cds.entities('factorypilot.cache')
    const active = await SELECT.from(CachePolicy).where({ isActive: true, cacheEnabled: true })
    const stats = await SELECT.from(CacheStat)
    const hits = stats.reduce((n, s) => n + (s.hits || 0), 0)
    const misses = stats.reduce((n, s) => n + (s.misses || 0), 0)
    const looks = hits + misses
    const ratio = looks ? Math.round((hits / looks) * 10000) / 100 : 0

    let message
    if (!active.length) {
      message = 'No active policy — nothing is being cached. Every question hits S/4 and the model.'
    } else if (cache.backend === 'memory') {
      message = 'In-process cache: correct for one instance, but each replica keeps its own. Bind Redis before scaling out.'
    } else if (looks < 20) {
      message = `Too few lookups (${looks}) to judge the hit ratio yet.`
    } else if (ratio < 10) {
      message = `Hit ratio ${ratio}% — the TTL may be shorter than the interval between repeat questions.`
    } else {
      message = `Hit ratio ${ratio}% across ${looks} lookups.`
    }

    return { backend: cache.backend, policiesActive: active.length, hitRatio: ratio, message }
  })
})
