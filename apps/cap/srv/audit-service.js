const cds = require('@sap/cds')

const CRITICALITY = { SUCCESS: 3, AWAITING_APPROVAL: 2, RATE_LIMITED: 2, RUNNING: 0, FAILED: 1 }

module.exports = cds.service.impl(function () {
  /**
   * Rate an answer. (BETA)
   *
   * Upsert rather than insert: someone re-rating has changed their mind, and
   * two rows would double-count them in every summary that follows.
   */
  this.on('rateAnswer', async (req) => {
    const { sessionLogID, rating, comment } = req.data
    const userID = req.user.id
    const clean = String(rating || '').toUpperCase()
    if (clean !== 'UP' && clean !== 'DOWN') {
      return req.reject(400, 'Rating must be UP or DOWN.')
    }

    const { SessionLog, AnswerFeedback } = cds.entities('factorypilot.audit')
    const log = await SELECT.one.from(SessionLog).where({ ID: sessionLogID })
    if (!log) return req.reject(404, 'No answer with that id.')

    const existing = await SELECT.one.from(AnswerFeedback).where({ sessionLog_ID: sessionLogID, userID })
    if (existing) {
      await UPDATE(AnswerFeedback)
        .set({ rating: clean, comment: comment || null, createdAt: new Date() })
        .where({ ID: existing.ID })
      return { sessionLogID, rating: clean, replaced: true, message: 'Rating updated.' }
    }
    await INSERT.into(AnswerFeedback).entries({
      ID: cds.utils.uuid(), sessionLog_ID: sessionLogID, userID,
      rating: clean, comment: comment || null, createdAt: new Date(),
    })
    return { sessionLogID, rating: clean, replaced: false, message: 'Thanks — recorded.' }
  })

  // Green / amber / red in the log explorer, so a failing run is visible
  // without reading the status column.
  this.after('READ', 'SessionLogs', (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row) row.statusCriticality = CRITICALITY[row.status] ?? 0
    }
  })

  this.after('READ', 'AgentRuns', (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row) row.statusCriticality = CRITICALITY[row.status] ?? 0
    }
  })

  // Users may only file feedback as themselves, and only against a log row
  // that exists — otherwise the feedback review queue fills with orphans.
  this.before('CREATE', 'Feedbacks', async (req) => {
    req.data.userID = req.user.id
    req.data.timestamp = new Date()
    if (req.data.sessionLogID) {
      const { SessionLog } = cds.entities('factorypilot.audit')
      const exists = await SELECT.one.from(SessionLog).where({ ID: req.data.sessionLogID })
      if (!exists) req.error(400, 'Unknown sessionLogID', 'sessionLogID')
    }
    const rating = req.data.rating
    if (rating != null && (rating < 1 || rating > 5)) req.error(400, 'rating must be between 1 and 5', 'rating')
  })

  // A non-admin sees only their own history.
  this.before('READ', ['SessionLogs', 'AgentRuns'], (req) => {
    if (!req.user.is('DashboardAdmin') && !req.user.is('AuditRead')) {
      req.query.where({ userID: req.user.id })
    }
  })
})
