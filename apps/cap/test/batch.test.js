const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { POST } = cds.test(PROJECT).in(PROJECT)

const agent = require('../srv/lib/agent')
const llm = require('../srv/lib/llm')

/**
 * Several writes from one question.
 *
 * This started as a feature and turned out to be a bug fix. The write branch
 * returned on the *first* write tool call in a round and discarded the rest,
 * so "rebalance these five materials" produced one confirmation card — the
 * user approved it and had every reason to believe all five had happened. A
 * partial action nobody was told about is the worst thing an approval gate can
 * produce, and it is worse than no batching at all.
 *
 * The second theme is that batching must not weaken anything. One button
 * pressing several writes is a convenience; it must not become a way to move an
 * anomalous action past a check by burying it among ordinary ones.
 */

const ADMIN = { auth: { username: 'admin', password: 'admin' } }

afterEach(async () => {
  const { PendingAction } = cds.entities('factorypilot.audit')
  await DELETE.from(PendingAction).where({ userID: 'batch-test' })
})

/** A provider that proposes exactly the writes it is given. */
function proposer(writes) {
  return [{
    name: 'openrouter', model: 'test',
    async complete() {
      return {
        text: 'Here is what I would do.',
        toolCalls: writes.map((w, i) => ({ id: `w${i}`, name: 'move_stock', arguments: w })),
        provider: 'openrouter', model: 'test',
        promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false,
      }
    },
  }]
}

async function propose(writes) {
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const real = llm.getProviderChain
  llm.getProviderChain = () => proposer(writes)
  try {
    return await agent.run({
      question: 'rebalance these materials',
      userID: 'batch-test', roles: [], warehouseID: '1000',
      conversationID: null, correlationId: 'batch-test',
      businessObjects: await SELECT.from(BusinessObjectConfig).where({ isActive: true }),
      route: {}, orgSettings: {},
    })
  } finally { llm.getProviderChain = real }
}

const MOVE = (material, quantity) => ({
  materialID: material, warehouseID: '1000',
  fromLocation: 'A1', toLocation: 'B2', quantity,
})

describe('every proposed write is surfaced', () => {
  test('one write still produces one proposal', async () => {
    const r = await propose([MOVE('P1', 10)])
    assert.equal(r.status, 'AWAITING_APPROVAL')
    assert.equal(r.pendingActions.length, 1)
    assert.ok(r.pendingAction, 'the single-action shape is unchanged')
  })

  test('five writes produce five proposals, not one', async () => {
    // The bug. Before this, four of these vanished silently.
    const r = await propose([
      MOVE('P1', 10), MOVE('P2', 20), MOVE('P3', 30), MOVE('P4', 40), MOVE('P5', 50),
    ])
    assert.equal(r.pendingActions.length, 5,
      'every write the model asked for must reach the approval gate')
  })

  test('each proposal describes its own move', async () => {
    const r = await propose([MOVE('P1', 10), MOVE('P2', 999)])
    const summaries = r.pendingActions.map((p) => p.summary)
    assert.ok(summaries.some((s) => s.includes('P1') && s.includes('10')))
    assert.ok(summaries.some((s) => s.includes('P2') && s.includes('999')))
  })

  test('each proposal is judged on its own, not as a group', async () => {
    // Batching must not launder an over-ceiling or anomalous move past the
    // checks by placing it among ordinary ones.
    const r = await propose([MOVE('P1', 1), MOVE('P2', 2)])
    for (const p of r.pendingActions) {
      assert.ok('autoApprovable' in p, 'every action carries its own policy decision')
      assert.ok('anomalous' in p, 'and its own anomaly verdict')
    }
  })

  test('all of them are reported as tools called', async () => {
    const r = await propose([MOVE('P1', 1), MOVE('P2', 2), MOVE('P3', 3)])
    const moves = r.toolsCalled.filter((t) => t === 'move_stock')
    assert.equal(moves.length, 3, 'the audit should show three writes were proposed')
  })
})

describe('deciding a batch', () => {
  test('a batch that does not exist is a clear 404', async () => {
    await assert.rejects(
      () => POST('/insights/confirmBatch',
        { batchID: '00000000-0000-0000-0000-000000000000', approve: true }, ADMIN),
      /No pending batch/)
  })

  test('rejecting a batch rejects every action in it', async () => {
    const { PendingAction } = cds.entities('factorypilot.audit')
    const batchID = cds.utils.uuid()
    const rows = ['P1', 'P2', 'P3'].map((m, i) => ({
      ID: cds.utils.uuid(), createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
      userID: 'admin', toolName: 'move_stock',
      arguments: JSON.stringify(MOVE(m, 10)),
      warehouseID: '1000', summary: `Move 10 of ${m}`,
      batchID, batchSeq: i, status: 'PENDING',
    }))
    await INSERT.into(PendingAction).entries(rows)

    const { data } = await POST('/insights/confirmBatch', { batchID, approve: false }, ADMIN)
    assert.equal(data.rejected, 3)
    assert.equal(data.approved, 0)
    const after = await SELECT.from(PendingAction).where({ batchID })
    assert.ok(after.every((a) => a.status !== 'PENDING'), 'none should still be pending')
    await DELETE.from(PendingAction).where({ batchID })
  })

  test('an already-decided action is skipped rather than run twice', async () => {
    // Pressing the button twice, or two people pressing it, must not execute
    // anything a second time — the guarantee the single-action path already
    // makes, preserved through the batch path.
    const { PendingAction } = cds.entities('factorypilot.audit')
    const batchID = cds.utils.uuid()
    await INSERT.into(PendingAction).entries([
      { ID: cds.utils.uuid(), createdAt: new Date(), expiresAt: new Date(Date.now() + 600000),
        userID: 'admin', toolName: 'move_stock', arguments: JSON.stringify(MOVE('P1', 1)),
        warehouseID: '1000', summary: 'Move 1 of P1', batchID, batchSeq: 0, status: 'CONSUMED' },
      { ID: cds.utils.uuid(), createdAt: new Date(), expiresAt: new Date(Date.now() + 600000),
        userID: 'admin', toolName: 'move_stock', arguments: JSON.stringify(MOVE('P2', 2)),
        warehouseID: '1000', summary: 'Move 2 of P2', batchID, batchSeq: 1, status: 'PENDING' },
    ])

    const { data } = await POST('/insights/confirmBatch', { batchID, approve: false }, ADMIN)
    assert.equal(data.skipped, 1, 'the consumed action should be left alone')
    assert.equal(data.rejected, 1, 'only the pending one should be decided')
    await DELETE.from(PendingAction).where({ batchID })
  })

  test('every action gets an outcome, in batch order', async () => {
    const { PendingAction } = cds.entities('factorypilot.audit')
    const batchID = cds.utils.uuid()
    await INSERT.into(PendingAction).entries(['P1', 'P2'].map((m, i) => ({
      ID: cds.utils.uuid(), createdAt: new Date(), expiresAt: new Date(Date.now() + 600000),
      userID: 'admin', toolName: 'move_stock', arguments: JSON.stringify(MOVE(m, 5)),
      warehouseID: '1000', summary: `Move 5 of ${m}`, batchID, batchSeq: i, status: 'PENDING',
    })))
    const { data } = await POST('/insights/confirmBatch', { batchID, approve: false }, ADMIN)
    assert.equal(data.outcomes.length, 2, 'no action may be decided without saying so')
    assert.match(data.outcomes[0].summary, /P1/)
    assert.match(data.outcomes[1].summary, /P2/)
    await DELETE.from(PendingAction).where({ batchID })
  })

  test('one user cannot decide a batch belonging to another', async () => {
    const { PendingAction } = cds.entities('factorypilot.audit')
    const batchID = cds.utils.uuid()
    await INSERT.into(PendingAction).entries([{
      ID: cds.utils.uuid(), createdAt: new Date(), expiresAt: new Date(Date.now() + 600000),
      userID: 'someone-else', toolName: 'move_stock', arguments: JSON.stringify(MOVE('P1', 1)),
      warehouseID: '1000', summary: 'Move 1 of P1', batchID, batchSeq: 0, status: 'PENDING',
    }])
    await assert.rejects(
      () => POST('/insights/confirmBatch', { batchID, approve: true }, ADMIN),
      /No pending batch/)
    await DELETE.from(PendingAction).where({ batchID })
  })
})

/**
 * What a confirmed write actually claims.
 *
 * Nothing currently reaches SAP — the Accelerator Hub sandbox this tenant
 * reads from is read-only, so there is no endpoint to post to. That is a fact
 * about the environment. What matters is that it is never *reported* as though
 * the write had landed: an operator who believes stock moved when it did not
 * is a worse outcome than one who is told plainly that it did not.
 */
describe('a confirmed write says what it really did', () => {
  const tools = require('../srv/lib/tools')

  test('it separates being recorded from being posted', async () => {
    const outcome = await tools.executeWrite('move_stock', {
      materialID: 'P1', warehouseID: '1000', quantity: 5,
    })
    assert.equal(outcome.applied, true, 'the action was consumed and audited')
    assert.equal(outcome.postedToSap, false, 'but nothing reached SAP')
  })

  test('the note says SAP is unchanged, in those words', async () => {
    // The previous note said "Recorded against the local ledger", which is
    // true and reads as jargon. "Stock in SAP is unchanged" cannot be misread.
    const outcome = await tools.executeWrite('move_stock', { materialID: 'P1', quantity: 5 })
    assert.match(outcome.note, /NOT posted to SAP/)
    assert.match(outcome.note, /unchanged/)
  })

  test('an unknown write tool is refused rather than silently accepted', async () => {
    await assert.rejects(
      () => tools.executeWrite('delete_everything', {}),
      /Unknown write tool/)
  })
})
