const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { POST, GET } = cds.test(PROJECT).in(PROJECT)

const asyncrun = require('../srv/lib/asyncrun')

/**
 * Questions allowed to take minutes.
 *
 * The risk in moving work off the request is not that it fails — it is that it
 * fails *invisibly*. A queued question that dies with its worker leaves someone
 * watching a spinner that never resolves, and quota reserved that is never
 * given back. Most of what follows is about that.
 */

const ADMIN = { auth: { username: 'admin', password: 'admin' } }

afterEach(async () => {
  const { AsyncRun } = cds.entities('factorypilot.jobs')
  await DELETE.from(AsyncRun).where({ userID: 'async-test' })
})

const queue = (fields = {}) => {
  const { AsyncRun } = cds.entities('factorypilot.jobs')
  const ID = cds.utils.uuid()
  return INSERT.into(AsyncRun).entries({
    ID, userID: 'async-test', question: 'why did stock drop last month?',
    warehouseID: '1000', status: 'QUEUED', queuedAt: new Date(),
    correlationId: `async-${ID.slice(0, 8)}`, quotaReserved: 100, ...fields,
  }).then(() => ID)
}

describe('claiming a queued question', () => {
  test('a queued run can be claimed', async () => {
    const ID = await queue()
    assert.equal(await asyncrun.claim(ID), true)
  })

  test('two workers cannot claim the same run', async () => {
    // The same guarantee the scheduler lease makes, at the level of a single
    // question: answering it twice would spend quota twice and audit twice.
    const ID = await queue()
    const results = await Promise.all(Array.from({ length: 6 }, () => asyncrun.claim(ID)))
    assert.equal(results.filter(Boolean).length, 1,
      `expected exactly one worker to win, got ${results.filter(Boolean).length}`)
  })

  test('a run already running cannot be claimed again', async () => {
    const ID = await queue({ status: 'RUNNING', startedAt: new Date() })
    assert.equal(await asyncrun.claim(ID), false)
  })
})

describe('a worker that dies mid-question', () => {
  test('a stale RUNNING run is buried rather than left spinning', async () => {
    // A container recycled, or a deploy landing. The agent keeps no
    // intermediate state so it cannot be resumed; leaving it RUNNING would
    // show the submitter a spinner that never resolves.
    const { AsyncRun } = cds.entities('factorypilot.jobs')
    const old = new Date(Date.now() - (asyncrun.STALE_AFTER_MS + 60_000))
    const ID = await queue({ status: 'RUNNING', startedAt: old })

    const result = await asyncrun.sweep()

    const after = await SELECT.one.from(AsyncRun).where({ ID })
    assert.equal(after.status, 'EXPIRED')
    assert.ok(result.expired >= 1)
    assert.match(after.errorDetail, /stopped before it finished/)
    assert.match(after.answer, /interrupted/)
  })

  test('a RUNNING run that is merely slow is left alone', async () => {
    const { AsyncRun } = cds.entities('factorypilot.jobs')
    const ID = await queue({ status: 'RUNNING', startedAt: new Date() })
    await asyncrun.sweep()
    const after = await SELECT.one.from(AsyncRun).where({ ID })
    assert.equal(after.status, 'RUNNING', 'slow is not the same as dead')
  })
})

describe('the service surface', () => {
  test('an empty question is refused', async () => {
    await assert.rejects(
      () => POST('/insights/askAsync', { question: '   ' }, ADMIN),
      /question is required/)
  })

  test('a question is queued and returns a run id immediately', async () => {
    const { data } = await POST('/insights/askAsync',
      { question: 'why did stock drop last month?', warehouseID: '1000' }, ADMIN)
    assert.ok(data.runID, 'a run id should come back at once')
    assert.equal(data.status, 'QUEUED')

    const { AsyncRun } = cds.entities('factorypilot.jobs')
    await DELETE.from(AsyncRun).where({ ID: data.runID })
  })

  test('the result of an unknown run is a 404, not an empty answer', async () => {
    await assert.rejects(
      () => GET(`/insights/asyncResult(runID=00000000-0000-0000-0000-000000000000)`, ADMIN),
      /No such run/)
  })

  test('one user cannot read the answer to another user’s question', async () => {
    // An async answer is exactly as private as the question that produced it,
    // and a run id is guessable enough for that to matter.
    const ID = await queue({ userID: 'somebody-else', status: 'SUCCESS', answer: 'private' })
    await assert.rejects(
      () => GET(`/insights/asyncResult(runID=${ID})`, ADMIN),
      /No such run/)
    const { AsyncRun } = cds.entities('factorypilot.jobs')
    await DELETE.from(AsyncRun).where({ ID })
  })
})

describe('what a finished run reports', () => {
  test('progress is readable while it waits', async () => {
    const { data } = await POST('/insights/askAsync', { question: 'a slow question' }, ADMIN)
    const { data: status } = await GET(`/insights/asyncResult(runID=${data.runID})`, ADMIN)
    assert.equal(status.status, 'QUEUED')
    assert.match(status.progress, /Queued/)
    const { AsyncRun } = cds.entities('factorypilot.jobs')
    await DELETE.from(AsyncRun).where({ ID: data.runID })
  })

  test('the budget is far larger than a request allows, but still finite', () => {
    // The point is to escape the 75-second request ceiling. It is not to let a
    // run hold a lease and burn quota forever for an answer nobody will read.
    assert.ok(asyncrun.ASYNC_BUDGET_MS > 75_000, 'it must beat the synchronous budget')
    assert.ok(asyncrun.ASYNC_BUDGET_MS <= 30 * 60_000, 'but it must still end')
  })

  test('a sweep takes a bounded number at a time', () => {
    // One worker holding one scheduler lease should not try to answer a
    // hundred queued questions in a single tick.
    assert.ok(asyncrun.BATCH >= 1 && asyncrun.BATCH <= 20)
  })
})
