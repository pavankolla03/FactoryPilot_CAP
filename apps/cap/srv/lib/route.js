const cds = require('@sap/cds')

/**
 * Which model answers this question.
 *
 * Two inputs, deliberately: what the question needs, and what the system can
 * currently afford.
 *
 * A lookup — "how much stock of P123" — is one tool call and a sentence of
 * arithmetic. Spending a 550B model on it costs latency the user feels and
 * money nobody gets back. Analysis — "compare last week to this week and tell
 * me what changed" — needs the larger model to be worth reading.
 *
 * Traffic is the second input because capacity is shared. When many requests
 * have landed in the last few minutes, everything drops to the light route:
 * degraded prose for everyone beats timeouts and rate-limit errors for the
 * unlucky, and the numbers come from the same tool output either way.
 */

/** Signals that a question wants reasoning rather than a lookup. */
const ANALYTICAL = [
  /\bcompare\b/i, /\bversus\b/i, /\bvs\.?\b/i, /\btrend\b/i, /\bwhy\b/i,
  /\bexplain\b/i, /\banalys|analyz/i, /\bforecast\b/i, /\bshould we\b/i,
  /\brecommend\b/i, /\broot cause\b/i, /\bbreak ?down\b/i, /\bgroup(ed)? by\b/i,
  /\bacross\b/i, /\bover time\b/i, /\bwhat changed\b/i, /\bimpact\b/i,
  /\bsummar(y|ise|ize)\b/i, /\bcorrelat/i,
]

/** A write is never light: the confirmation card it produces is read by a
 *  human who is about to change a real system. */
const WRITE_HINT = /\b(move|transfer|post|create|update|delete|relocate|adjust)\b/i

const LONG_QUESTION_WORDS = 25

function complexityOf(question = '') {
  const q = String(question)
  if (WRITE_HINT.test(q)) return 'heavy'
  if (ANALYTICAL.some((re) => re.test(q))) return 'heavy'
  if (q.trim().split(/\s+/).length > LONG_QUESTION_WORDS) return 'heavy'
  // Several questions bundled into one sentence need more than a lookup.
  if ((q.match(/\?/g) || []).length > 1) return 'heavy'
  return 'light'
}

/**
 * Requests in the recent past, used as a load signal.
 *
 * Counted from the audit log because that is the one row every request writes,
 * whatever its outcome — so it counts rate-limited and failed traffic too,
 * which is exactly the load that should push the system to be cheaper.
 */
async function recentLoad(windowMinutes = 5) {
  try {
    const { SessionLog } = cds.entities('factorypilot.audit')
    const since = new Date(Date.now() - windowMinutes * 60000)
    const row = await SELECT.one`count(*) as n`.from(SessionLog).where({ timestamp: { '>=': since } })
    return Number(row?.n || 0)
  } catch {
    // Never let a load probe decide a request cannot be answered.
    return 0
  }
}

const BUSY_THRESHOLD = Number(process.env.FACTORYPILOT_BUSY_RPM || 30)

/**
 * Resolve the ModelRoute row to use, and say why.
 *
 * `why` is returned rather than logged so the answer can carry it: an operator
 * asking "why did this one sound terser?" gets an answer instead of a guess.
 */
async function pick({ question, forced = process.env.LLM_ROUTE, load } = {}) {
  const { ModelRoute } = cds.entities('factorypilot.token')
  const rows = await SELECT.from(ModelRoute).where({ isActive: true })
  const byName = new Map(rows.map((r) => [r.route, r]))

  const wanted = complexityOf(question)
  let chosen = forced || wanted
  let why = forced ? `forced by LLM_ROUTE=${forced}` : `question looks ${wanted}`

  if (!forced && chosen === 'heavy') {
    // `load` is injectable so the downgrade can be tested in both directions
    // without a test suite's own traffic deciding the outcome — which is
    // exactly what happened the first time this was written.
    const observed = load ?? (await recentLoad())
    if (observed >= BUSY_THRESHOLD) {
      chosen = 'light'
      why = `${observed} requests in the last 5 minutes — using the light route to stay responsive`
    }
  }

  const route = byName.get(chosen) || byName.get('heavy') || byName.get('light') || rows[0] || null
  return { route, chosen: route?.route || chosen, why, complexity: wanted }
}

module.exports = { pick, complexityOf, recentLoad, ANALYTICAL, BUSY_THRESHOLD }
