/**
 * Scheduled exports. (BETA)
 *
 * Unglamorous and frequently asked for. Somebody has to show a number to
 * somebody else — a steering committee, a finance review, a QBR — and today
 * that means opening the product and copying figures out of a screen. A file
 * that arrives on a schedule removes a recurring chore, which is a small win
 * repeated weekly rather than a large one once.
 *
 * CSV rather than Excel or PDF, deliberately. A spreadsheet library is a
 * dependency and a rendering surface for something every tool on the receiving
 * end already opens natively; PDF is worse, because it is the format people
 * ask for and then immediately try to get the numbers back out of. CSV is the
 * one that survives being pasted somewhere else, which is what actually
 * happens to it.
 */

const cds = require('@sap/cds')

const log = cds.log('exports')

/** Escape one CSV field. */
function cell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  // Quote when the value contains a delimiter, a quote or a newline — and
  // double any quotes inside. Getting this wrong shifts every later column of
  // that row, which is the kind of corruption nobody notices until a total is
  // wrong in a meeting.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows, columns) {
  const head = columns.map(cell).join(',')
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(',')).join('\n')
  return rows.length ? `${head}\n${body}` : head
}

/**
 * The reports worth sending on a schedule.
 *
 * Each one answers a question somebody actually asks out loud, rather than
 * dumping a table because the table exists.
 */
const REPORTS = {
  usage: {
    title: 'Usage by user',
    question: 'Who is using this, and what is it costing?',
    columns: ['userID', 'requests', 'tokensUsed', 'denied'],
    async rows(since) {
      const { SessionLog } = cds.entities('factorypilot.audit')
      const logs = await SELECT.from(SessionLog).where({ timestamp: { '>=': since } })
      const by = new Map()
      for (const l of logs) {
        const u = by.get(l.userID) || { userID: l.userID, requests: 0, tokensUsed: 0, denied: 0 }
        u.requests++
        u.tokensUsed += Number(l.tokensUsed) || 0
        if (l.quotaResult === 'DENIED') u.denied++
        by.set(l.userID, u)
      }
      return [...by.values()].sort((a, b) => b.requests - a.requests)
    },
  },
  quality: {
    title: 'Answer quality',
    question: 'Are the answers grounded, and what did people think of them?',
    columns: ['day', 'answers', 'grounded', 'ungrounded', 'ratedUp', 'ratedDown'],
    async rows(since) {
      const { SessionLog, AnswerFeedback } = cds.entities('factorypilot.audit')
      const logs = await SELECT.from(SessionLog).where({ timestamp: { '>=': since } })
      const feedback = await SELECT.from(AnswerFeedback)
      const ratingByLog = new Map(feedback.map((f) => [f.sessionLog_ID, f.rating]))
      const by = new Map()
      for (const l of logs) {
        const day = new Date(l.timestamp).toISOString().slice(0, 10)
        const d = by.get(day) || { day, answers: 0, grounded: 0, ungrounded: 0, ratedUp: 0, ratedDown: 0 }
        d.answers++
        if (l.grounded) d.grounded++
        else d.ungrounded++
        const r = ratingByLog.get(l.ID)
        if (r === 'UP') d.ratedUp++
        if (r === 'DOWN') d.ratedDown++
        by.set(day, d)
      }
      return [...by.values()].sort((a, b) => a.day.localeCompare(b.day))
    },
  },
  failures: {
    title: 'Failed questions',
    question: 'What did not work, so it can be fixed?',
    columns: ['timestamp', 'userID', 'userQuery', 'status', 'errorDetail'],
    async rows(since) {
      const { SessionLog } = cds.entities('factorypilot.audit')
      const rows = await SELECT.from(SessionLog)
        .where({ timestamp: { '>=': since }, status: 'FAILED' })
        .orderBy('timestamp')
      return rows.map((r) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        userID: r.userID,
        userQuery: r.userQuery,
        status: r.status,
        errorDetail: (r.errorDetail || '').slice(0, 300),
      }))
    },
  },
}

const DEFAULT_DAYS = Number(process.env.FACTORYPILOT_EXPORT_DAYS || 7)

/** Build one report. Returns the CSV and enough to describe it. */
async function build(name, { days = DEFAULT_DAYS } = {}) {
  const report = REPORTS[name]
  if (!report) {
    throw new Error(`Unknown report "${name}". Known reports: ${Object.keys(REPORTS).join(', ')}.`)
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = await report.rows(since)
  return {
    name,
    title: report.title,
    question: report.question,
    days,
    since,
    rowCount: rows.length,
    filename: `intelliops4-${name}-${new Date().toISOString().slice(0, 10)}.csv`,
    csv: toCsv(rows, report.columns),
  }
}

/** Build every report, for the scheduled job. */
async function buildAll(options) {
  const out = []
  for (const name of Object.keys(REPORTS)) {
    try {
      out.push(await build(name, options))
    } catch (err) {
      // One report that cannot be built must not cost the others. Recorded so
      // an empty attachment is never mistaken for a quiet week.
      log.warn(`export "${name}" failed: ${err.message}`)
      out.push({ name, error: err.message })
    }
  }
  return out
}

/** A short human summary to accompany the files. */
function describe(reports) {
  const lines = ['[BETA]', '']
  for (const r of reports) {
    if (r.error) { lines.push(`${r.name}: could not be built — ${r.error}`); continue }
    lines.push(`${r.title}: ${r.rowCount} row${r.rowCount === 1 ? '' : 's'} over ${r.days} days`)
  }
  const broken = reports.filter((r) => r.error).length
  if (broken) lines.push('', `${broken} report${broken === 1 ? '' : 's'} could not be built — this export is incomplete.`)
  return lines.join('\n')
}

module.exports = { REPORTS, build, buildAll, describe, toCsv, cell, DEFAULT_DAYS }
