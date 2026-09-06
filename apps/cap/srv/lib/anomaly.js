/**
 * Anomaly detection over reads. (BETA)
 *
 * A watcher catches what you thought to threshold. This catches what you did
 * not — and in practice nobody sets a threshold for a thing until after it has
 * bitten them once, so this is where most of the value in proactive monitoring
 * actually sits.
 *
 * Three decisions worth keeping:
 *
 * **Both directions.** `policy.detectAnomaly` — which gates writes — only ever
 * looks upward, because a write that is 50× the usual is the dangerous one. For
 * reads the opposite is at least as interesting: stock that has fallen to a
 * third of its normal level is the alert somebody wants at six in the morning.
 *
 * **Median, not mean.** One bad day drags a mean far enough that the next
 * genuinely bad day looks normal — the metric quietly stops working exactly
 * after the event that should have taught it something. A median shrugs off
 * outliers, which is the entire job here.
 *
 * **Silence until there is history.** With three points, everything looks
 * anomalous. Alerting from a standing start would train the recipient to
 * ignore this within its first week, and an ignored alert is worse than none
 * because everyone still believes it works.
 */

const cds = require('@sap/cds')
const tools = require('./tools')

const log = cds.log('anomaly')

/** Observations needed before any judgement is made. */
const MIN_HISTORY = Number(process.env.FACTORYPILOT_ANOMALY_MIN_HISTORY || 5)

/** How far back to look. Long enough to know normal, short enough to follow it. */
const HISTORY_DAYS = Number(process.env.FACTORYPILOT_ANOMALY_DAYS || 14)

const READ_TIMEOUT_MS = Number(process.env.FACTORYPILOT_ANOMALY_READ_MS || 20_000)

/** Middle value; the average of the middle two when the count is even. */
function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Judge one value against its own history.
 *
 * `factor` comes from `OrgSettings.anomalyFactor`, the same dial that governs
 * write anomalies — one setting for "how surprised should this system get",
 * rather than two that drift apart.
 */
function judge(value, history, factor = 5) {
  if (history.length < MIN_HISTORY) {
    return { anomalous: false, reason: `only ${history.length} observations so far` }
  }
  const mid = median(history)
  if (mid === null) return { anomalous: false }

  // A series that has always been zero has no meaningful ratio, and dividing
  // by it would make the first non-zero reading infinitely surprising.
  if (mid === 0) {
    return value > 0
      ? { anomalous: true, ratio: null,
          reason: `${value} where this has always been 0 across ${history.length} observations.` }
      : { anomalous: false }
  }

  const ratio = value / mid
  if (ratio >= factor) {
    return { anomalous: true, ratio,
      reason: `${value} is ${ratio.toFixed(1)}× the usual ${mid} (median of ${history.length} observations).` }
  }
  if (ratio <= 1 / factor) {
    return { anomalous: true, ratio,
      reason: `${value} is well below the usual ${mid} — about ${(ratio * 100).toFixed(0)}% of it (median of ${history.length} observations).` }
  }
  return { anomalous: false, ratio }
}

/**
 * Observe every active business object once, and judge each against its past.
 *
 * Returns what it found; delivery is the caller's business, which keeps this
 * testable without a webhook.
 */
async function sweep({ correlationId = `anomaly-${Date.now()}` } = {}) {
  const { Observation } = cds.entities('factorypilot.jobs')
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const { OrgSettings } = cds.entities('factorypilot.admin')

  const businessObjects = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
  if (!businessObjects.length) return { observed: 0, findings: [], errors: [] }

  const org = await SELECT.one.from(OrgSettings)
  const factor = Number(org?.anomalyFactor) || 5
  const warehouse = org?.defaultWarehouse || ''
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const now = new Date()

  const findings = []
  const errors = []
  let observed = 0

  for (const bo of businessObjects) {
    let rowCount
    try {
      const result = await tools.executeRead(
        tools.toolNameFor(bo.objectCode), {},
        { businessObjects, defaults: { warehouse }, correlationId, timeoutMs: READ_TIMEOUT_MS })
      rowCount = result.rowCount ?? result.rows?.length ?? 0
    } catch (err) {
      // Not recorded as an observation. A failed read is not a data point, and
      // storing it as zero would poison the median and make the next real
      // reading look like a spike.
      errors.push({ objectCode: bo.objectCode, error: err.message.slice(0, 200) })
      log.warn(`anomaly sweep could not read ${bo.objectCode}: ${err.message}`)
      continue
    }

    const past = await SELECT.from(Observation)
      .where({ objectCode: bo.objectCode, warehouseID: warehouse || null, observedAt: { '>': since } })
    const history = past.map((o) => Number(o.rowCount)).filter(Number.isFinite)

    const verdict = judge(rowCount, history, factor)
    await INSERT.into(Observation).entries({
      objectCode: bo.objectCode,
      warehouseID: warehouse || null,
      observedAt: now,
      rowCount,
      flagged: Boolean(verdict.anomalous),
      reason: verdict.anomalous ? verdict.reason.slice(0, 300) : null,
    })
    observed++

    if (verdict.anomalous) {
      findings.push({
        objectCode: bo.objectCode,
        objectName: bo.objectName || bo.objectCode,
        warehouseID: warehouse,
        value: rowCount,
        ratio: verdict.ratio,
        reason: verdict.reason,
      })
    }
  }

  return { observed, findings, errors, factor }
}

/** Render a sweep into the message a person receives. */
function render(result) {
  const lines = ['[BETA]', '']
  if (!result.findings.length) lines.push('Nothing unusual.')
  for (const f of result.findings) {
    lines.push(`⚠  ${f.objectName}${f.warehouseID ? ` (plant ${f.warehouseID})` : ''}: ${f.reason}`)
  }
  if (result.errors.length) {
    lines.push('')
    for (const e of result.errors) lines.push(`?  ${e.objectCode}: could not be read — ${e.error}`)
    lines.push('These were not recorded — a failed read is not an observation, and storing it')
    lines.push('as zero would distort what counts as normal from here on.')
  }
  return lines.join('\n')
}

module.exports = { sweep, judge, median, render, MIN_HISTORY, HISTORY_DAYS }
