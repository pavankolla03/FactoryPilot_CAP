const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const agent = require('../srv/lib/agent')
const llm = require('../srv/lib/llm')
const tools = require('../srv/lib/tools')

/**
 * A full page is not a total.
 *
 * Reads ask for 200 rows. Every bundled fixture is smaller than that, so in
 * testing `rowCount` has always been the true number of matching records — and
 * the system prompt tells the model, in as many words, to quote it as the
 * total. Point the product at a plant with five thousand open deliveries and
 * the same instruction produces "there are 200 open deliveries", stated with
 * the confidence of a real count and with a real audit row behind it.
 *
 * Nothing could have caught this before a live tenant answered, which is
 * exactly why it needs a test now that one is about to.
 */

/** A provider that records every message it is handed and then stops. */
function recorder(seen) {
  return [{
    name: 'rec',
    model: 'rec-1',
    async complete({ messages }) {
      seen.push(...messages)
      return {
        text: 'ok', toolCalls: [], provider: 'rec', model: 'rec-1',
        promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false,
      }
    },
  }]
}

/** One model turn that calls the delivery tool, then a turn that answers. */
function callsThenAnswers(seen, toolName) {
  let turn = 0
  return [{
    name: 'rec',
    model: 'rec-1',
    async complete({ messages }) {
      seen.length = 0
      seen.push(...messages)
      turn += 1
      if (turn === 1) {
        return {
          text: '', provider: 'rec', model: 'rec-1',
          toolCalls: [{ id: 't1', name: toolName, arguments: { warehouseID: '1000' } }],
          promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false,
        }
      }
      return {
        text: 'answered', toolCalls: [], provider: 'rec', model: 'rec-1',
        promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false,
      }
    },
  }]
}

async function withChain(chain, fn) {
  const real = llm.getProviderChain
  llm.getProviderChain = () => chain
  try { return await fn() } finally { llm.getProviderChain = real }
}

async function withRead(stub, fn) {
  const real = tools.executeRead
  tools.executeRead = stub
  try { return await fn() } finally { tools.executeRead = real }
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ DeliveryDocument: `800${String(i).padStart(5, '0')}` }))

async function runWith(readResult) {
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const businessObjects = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
  const bo = businessObjects[0]
  const toolName = tools.toolNameFor(bo.objectCode)

  const seen = []
  await withChain(callsThenAnswers(seen, toolName), () =>
    withRead(async () => readResult, () =>
      agent.run({
        question: 'how many deliveries are open?',
        userID: 'admin', roles: ['InsightsQuery'], warehouseID: '1000',
        conversationID: null, correlationId: 'page-test',
        businessObjects, route: { route: 'light', provider: 'rec', model: 'rec-1' },
        orgSettings: {},
      })))

  // The tool result is the message the model is asked to reason from.
  const toolMessage = seen.reverse().find((m) => m.role === 'tool')
  assert.ok(toolMessage, 'the model should have been handed a tool result')
  return JSON.parse(toolMessage.content)
}

describe('a page limit is never reported as a count', () => {
  test('a short result is a real total', async () => {
    const payload = await runWith({
      objectCode: 'DELIVERY', filter: '', rows: rows(37), url: 'mock://x', elapsedMs: 1,
      pageSize: 200, atPageLimit: false,
    })
    assert.equal(payload.rowCount, 37)
    assert.equal(payload.rowCountIsAtLeast, undefined, 'nothing to qualify — 37 really is the total')
  })

  test('a result that fills the page is marked as a lower bound', async () => {
    const payload = await runWith({
      objectCode: 'DELIVERY', filter: '', rows: rows(200), url: 'mock://x', elapsedMs: 1,
      pageSize: 200, atPageLimit: true,
    })
    assert.equal(payload.rowCount, 200)
    assert.equal(payload.rowCountIsAtLeast, true)
    assert.equal(payload.pageSize, 200)
    // The model reads the note, not the field name, so the note has to say it.
    assert.match(payload.note, /at least/i)
    assert.match(payload.note, /Do not state rowCount as the total/i)
  })

  test('the instruction to quote rowCount as the total is qualified in the prompt', async () => {
    const seen = []
    await withChain(recorder(seen), () =>
      agent.run({
        question: 'hello',
        userID: 'admin', roles: ['InsightsQuery'], warehouseID: '1000',
        conversationID: null, correlationId: 'page-prompt',
        businessObjects: [], route: { route: 'light', provider: 'rec', model: 'rec-1' },
        orgSettings: {},
      }))
    const system = seen.find((m) => m.role === 'system')
    assert.ok(system, 'there should be a system prompt')
    assert.match(
      system.content,
      /rowCountIsAtLeast/,
      'the rule telling the model to quote rowCount as the total must name its own exception'
    )
  })
})
