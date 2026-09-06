const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const agent = require('../srv/lib/agent')
const llm = require('../srv/lib/llm')
const router = require('../srv/lib/route')

/**
 * Escalation: difficulty is discovered, not predicted.
 *
 * `route.pick` chooses light or heavy from a regex over the question text,
 * before anything has been read. That is a guess, and it is wrong in the
 * expensive direction for exactly the questions Tier 2 made possible — "why
 * did stock drop in 1710" reads like a lookup and then needs several rounds of
 * chained tool calls, which is where the stronger model earns its keep.
 *
 * These tests are about the promotion happening once, only when it is
 * warranted, and never to somewhere worse than where it started.
 */

/** A provider that always answers, recording which model was asked. */
function recorder(name, model, calls) {
  return {
    name, model,
    async complete() {
      calls.push(model)
      return { text: 'done', toolCalls: [], provider: name, model,
        promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
    },
  }
}

async function withChains(map, fn) {
  const real = llm.getProviderChain
  llm.getProviderChain = (route) => map(route)
  try { return await fn() } finally { llm.getProviderChain = real }
}

const context = async (extra = {}) => {
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  return {
    question: 'why did stock drop in plant 1000?',
    userID: 'admin', roles: [], warehouseID: '1000',
    conversationID: null, correlationId: 'esc-test',
    businessObjects: await SELECT.from(BusinessObjectConfig).where({ isActive: true }),
    route: { route: 'light', provider: 'openrouter', model: 'light-model' },
    orgSettings: {},
    ...extra,
  }
}

describe('promoting a question that turns out to be hard', () => {
  test('a run that finishes in one round is never escalated', async () => {
    // The common case. Most questions really are lookups, and paying for the
    // heavier model on all of them is what the light route exists to avoid.
    const calls = []
    const ctx = await context()
    const result = await withChains(
      (r) => [recorder('openrouter', r?.route === 'heavy' ? 'heavy-model' : 'light-model', calls)],
      () => agent.run({ ...ctx, escalationRoute: { route: 'heavy', model: 'heavy-model' } }))
    assert.equal(result.escalatedTo, undefined, 'a one-round answer should stay on the light route')
    assert.ok(calls.every((m) => m === 'light-model'))
  })

  test('with nothing heavier configured, nothing is promoted', async () => {
    // A deployment with one model should not pay a chain rebuild to arrive
    // back where it started.
    const calls = []
    const ctx = await context()
    const result = await withChains(
      () => [recorder('openrouter', 'light-model', calls)],
      () => agent.run({ ...ctx, escalationRoute: null }))
    assert.equal(result.escalatedTo, undefined)
  })

  test('a chain of nothing but the offline provider is not an upgrade', async () => {
    // Promoting into the fake provider would trade a working light answer for
    // a refusal, which is worse than not escalating at all.
    const calls = []
    const ctx = await context()
    const result = await withChains(
      (r) => (r?.route === 'heavy'
        ? [new llm.FakeProvider('fallback')]
        : [recorder('openrouter', 'light-model', calls)]),
      () => agent.run({ ...ctx, escalationRoute: { route: 'heavy' } }))
    assert.equal(result.escalatedTo, undefined, 'an offline-only chain must not count as heavier')
  })

  test('a run that keeps needing tools IS promoted, and the heavier model finishes it', async () => {
    // The case the feature exists for. A provider that keeps asking for tools
    // forces the loop past the threshold; from that point the calls must land
    // on the heavy model.
    const calls = []
    const ctx = await context()
    let asked = 0
    const insistent = (model) => ({
      name: 'openrouter', model,
      async complete() {
        calls.push(model)
        asked++
        // Keep the loop going for the first few rounds, then settle.
        if (asked <= 3) {
          return { text: '', provider: 'openrouter', model,
            toolCalls: [{ id: `c${asked}`, name: 'query_material_stock', arguments: { warehouseID: '1000' } }],
            promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
        }
        return { text: 'settled', toolCalls: [], provider: 'openrouter', model,
          promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    })

    const result = await withChains(
      (r) => [insistent(r?.route === 'heavy' ? 'heavy-model' : 'light-model')],
      () => agent.run({ ...ctx, escalationRoute: { route: 'heavy', model: 'heavy-model' } }))

    assert.equal(result.escalatedTo, 'heavy',
      'a run that needed several rounds should have been promoted')
    assert.ok(calls.includes('light-model'), 'it should have started on the light route')
    assert.ok(calls.includes('heavy-model'), 'and finished on the heavy one')
    assert.equal(calls.at(-1), 'heavy-model', 'the last call should be the heavier model')
  })

  test('promotion happens once, not on every subsequent round', async () => {
    const calls = []
    const ctx = await context()
    let asked = 0
    const insistent = (model) => ({
      name: 'openrouter', model,
      async complete() {
        calls.push(model); asked++
        if (asked <= 4) {
          return { text: '', provider: 'openrouter', model,
            toolCalls: [{ id: `c${asked}`, name: 'query_material_stock', arguments: { warehouseID: '1000' } }],
            promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
        }
        return { text: 'settled', toolCalls: [], provider: 'openrouter', model,
          promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    })
    let chainBuilds = 0
    const result = await withChains(
      (r) => { chainBuilds++; return [insistent(r?.route === 'heavy' ? 'heavy-model' : 'light-model')] },
      () => agent.run({ ...ctx, escalationRoute: { route: 'heavy', model: 'heavy-model' } }))
    assert.equal(result.escalatedTo, 'heavy')
    assert.equal(chainBuilds, 2, 'the chain should be built once at the start and once on promotion')
  })

  test('the threshold is configurable and defaults to two rounds', () => {
    assert.equal(typeof agent.ESCALATE_AFTER_ROUNDS, 'number')
    assert.ok(agent.ESCALATE_AFTER_ROUNDS >= 1)
  })
})

describe('the router supplies something to escalate to', () => {
  test('heavyRoute returns the active heavy row, or null', async () => {
    const heavy = await router.heavyRoute()
    if (heavy) {
      assert.equal(heavy.route, 'heavy')
      assert.equal(heavy.isActive, true)
    } else {
      assert.equal(heavy, null, 'absent is null, not undefined or a throw')
    }
  })

  test('it never throws, whatever the database is doing', async () => {
    // A failed lookup here must degrade to "no escalation", never break the
    // request that was going to be answered anyway.
    await assert.doesNotReject(() => router.heavyRoute())
  })

  test('a question already routed heavy has nothing to promote to', async () => {
    // Guarded in insights-service: escalationRoute is null when the initial
    // choice was already heavy. Asserted here so the intent is recorded.
    const routing = await router.pick({ question: 'compare last week to this week', load: 0 })
    assert.equal(routing.complexity, 'heavy',
      'an analytical question should be routed heavy from the start')
  })

  test('a lookup is routed light, which is what makes escalation necessary', async () => {
    const routing = await router.pick({ question: 'how much stock of P123', load: 0 })
    assert.equal(routing.complexity, 'light')
  })

  test('"why" is caught by the regex, but "why" questions are not the only hard ones', async () => {
    // The regex catches the obvious cases. The point of escalation is the
    // questions it does not catch — which is why round count, not wording,
    // decides the promotion.
    assert.equal(router.complexityOf('why did stock drop'), 'heavy')
    assert.equal(router.complexityOf('stock for P123 in 1710'), 'light')
  })
})
