const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { GET, POST } = cds.test(PROJECT).in(PROJECT)

/**
 * Feedback, and the vetted question library.
 *
 * A rating on its own is a vanity metric — "83% positive" tells nobody what to
 * do on Monday. Keyed to the audit row it becomes joinable to the provider,
 * model, tools and grounding of the answer it refers to, and *that* is
 * actionable: "every negative rating this week was ungrounded" is a finding.
 * So the tests care most about the join surviving and about one person
 * counting once.
 */

const ADMIN = { auth: { username: 'admin', password: 'admin' } }

async function anAnsweredQuestion() {
  const { SessionLog } = cds.entities('factorypilot.audit')
  const ID = cds.utils.uuid()
  await INSERT.into(SessionLog).entries({
    ID, timestamp: new Date(), userID: 'admin', channel: 'Web',
    userQuery: 'how much stock in 1710?', status: 'SUCCESS',
    grounded: true, llmProvider: 'openrouter', llmModel: 'test-model',
    tokensUsed: 100, cacheResult: 'MISS',
  })
  return ID
}

afterEach(async () => {
  const { AnswerFeedback, SessionLog } = cds.entities('factorypilot.audit')
  await DELETE.from(AnswerFeedback).where({ userID: 'admin' })
  await DELETE.from(SessionLog).where({ userQuery: 'how much stock in 1710?' })
})

describe('rating an answer', () => {
  test('a rating is recorded against the answer it refers to', async () => {
    const sessionLogID = await anAnsweredQuestion()
    const { data } = await POST('/odata/audit/rateAnswer',
      { sessionLogID, rating: 'UP', comment: 'exactly what I needed' }, ADMIN)
    assert.equal(data.rating, 'UP')
    assert.equal(data.replaced, false)

    const { AnswerFeedback } = cds.entities('factorypilot.audit')
    const row = await SELECT.one.from(AnswerFeedback).where({ sessionLog_ID: sessionLogID })
    assert.ok(row, 'the rating should be findable from the answer')
    assert.equal(row.comment, 'exactly what I needed')
  })

  test('re-rating replaces rather than adding a second opinion', async () => {
    // Two rows would double-count one person in every summary that follows.
    const sessionLogID = await anAnsweredQuestion()
    await POST('/odata/audit/rateAnswer', { sessionLogID, rating: 'UP' }, ADMIN)
    const { data } = await POST('/odata/audit/rateAnswer',
      { sessionLogID, rating: 'DOWN', comment: 'actually the plant was wrong' }, ADMIN)
    assert.equal(data.replaced, true)

    const { AnswerFeedback } = cds.entities('factorypilot.audit')
    const rows = await SELECT.from(AnswerFeedback).where({ sessionLog_ID: sessionLogID })
    assert.equal(rows.length, 1, 'changing your mind is not a second opinion')
    assert.equal(rows[0].rating, 'DOWN')
  })

  test('only UP or DOWN — no scale nobody agrees on', async () => {
    // A 1-5 scale invites arguments about what 3 means, and the only decision
    // this feeds is "go and look at these answers".
    const sessionLogID = await anAnsweredQuestion()
    await assert.rejects(
      () => POST('/odata/audit/rateAnswer', { sessionLogID, rating: 'MAYBE' }, ADMIN),
      /UP or DOWN/)
    await assert.rejects(
      () => POST('/odata/audit/rateAnswer', { sessionLogID, rating: '4' }, ADMIN),
      /UP or DOWN/)
  })

  test('lowercase is accepted — the UI should not have to shout', async () => {
    const sessionLogID = await anAnsweredQuestion()
    const { data } = await POST('/odata/audit/rateAnswer', { sessionLogID, rating: 'up' }, ADMIN)
    assert.equal(data.rating, 'UP')
  })

  test('rating an answer that does not exist is a 404', async () => {
    await assert.rejects(
      () => POST('/odata/audit/rateAnswer',
        { sessionLogID: '00000000-0000-0000-0000-000000000000', rating: 'UP' }, ADMIN),
      /No answer with that id/)
  })

  test('the rating can be joined back to what produced the answer', async () => {
    // The whole point. A rating that cannot be joined to provider, model and
    // grounding is a number nobody can act on.
    const sessionLogID = await anAnsweredQuestion()
    await POST('/odata/audit/rateAnswer', { sessionLogID, rating: 'DOWN' }, ADMIN)

    const { data: fb } = await GET(
      `/odata/audit/AnswerFeedbacks?$filter=sessionLog_ID eq ${sessionLogID}`, ADMIN)
    assert.equal(fb.value.length, 1)
    const { data: log } = await GET(
      `/odata/audit/SessionLogs?$filter=ID eq ${sessionLogID}&$select=grounded,llmModel`, ADMIN)
    assert.equal(log.value[0].grounded, true)
    assert.equal(log.value[0].llmModel, 'test-model')
  })
})

describe('the saved question library', () => {
  afterEach(async () => {
    const { SavedQuestion } = cds.entities('factorypilot.config')
    await DELETE.from(SavedQuestion).where({ title: { like: 'test-%' } })
  })

  test('an operator can read the library', async () => {
    const { data } = await GET('/odata/config/SavedQuestions?$select=title,question', ADMIN)
    assert.ok(Array.isArray(data.value))
  })

  test('a saved question round-trips through create and activate', async () => {
    const { data: draft } = await POST('/odata/config/SavedQuestions',
      { title: 'test-open-counts', question: 'Show me open inventory counts', sortOrder: 10 }, ADMIN)
    await POST(
      `/odata/config/SavedQuestions(ID=${draft.ID},IsActiveEntity=false)/ConfigService.draftActivate`,
      {}, ADMIN)

    const { SavedQuestion } = cds.entities('factorypilot.config')
    const row = await SELECT.one.from(SavedQuestion).where({ title: 'test-open-counts' })
    assert.ok(row)
    assert.equal(row.question, 'Show me open inventory counts')
    assert.equal(row.useCount, 0, 'a new entry has not been used yet')
    assert.equal(row.isActive, true)
  })

  test('use is counted, so an unused library is visible as unused', async () => {
    const { SavedQuestion } = cds.entities('factorypilot.config')
    const ID = cds.utils.uuid()
    await INSERT.into(SavedQuestion).entries({
      ID, title: 'test-counted', question: 'anything', isActive: true, useCount: 0 })
    await UPDATE(SavedQuestion).set({ useCount: { '+=': 1 } }).where({ ID })
    const row = await SELECT.one.from(SavedQuestion).where({ ID })
    assert.equal(row.useCount, 1)
  })

  test('asking a saved question through the chat surface counts as a use', async () => {
    const { SavedQuestion } = cds.entities('factorypilot.config')
    const ID = cds.utils.uuid()
    await INSERT.into(SavedQuestion).entries({
      ID, title: 'test-via-action', question: 'anything', isActive: true, useCount: 0 })

    const { data } = await POST('/odata/config/useSavedQuestion', { ID }, ADMIN)
    assert.equal(data.value, true)
    const row = await SELECT.one.from(SavedQuestion).where({ ID })
    assert.equal(row.useCount, 1, 'the count reflects the question actually being asked')
  })

  test('an inactive or unknown question is not counted', async () => {
    const { SavedQuestion } = cds.entities('factorypilot.config')
    const ID = cds.utils.uuid()
    await INSERT.into(SavedQuestion).entries({
      ID, title: 'test-inactive', question: 'anything', isActive: false, useCount: 0 })

    const { data } = await POST('/odata/config/useSavedQuestion', { ID }, ADMIN)
    assert.equal(data.value, false, 'a draft or retired question is not offered, so a use cannot be real')
    const row = await SELECT.one.from(SavedQuestion).where({ ID })
    assert.equal(row.useCount, 0)
  })
})
