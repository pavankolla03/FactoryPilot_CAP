const { test, describe, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')

// In-memory SQLite per run: the tests own their data and never touch the
// developer's db/factorypilot.db.
const { GET, POST, PATCH, expect: _unused, data } = cds.test(PROJECT).in(PROJECT)

/**
 * Create a row the way the Admin screens do: POST a draft, then activate it.
 *
 * Draft-enabled entities accept an incomplete POST on purpose — that is what a
 * draft is for, and it is why the Admin UI can offer a half-filled form without
 * the server refusing every keystroke. The rules that used to reject a bad POST
 * now run at activation, so a test that only POSTs proves nothing about them.
 */
async function createActive(collection, service, payload, auth) {
  const { data: draft } = await POST(collection, payload, auth)
  return POST(`${collection}(ID=${draft.ID},IsActiveEntity=false)/${service}.draftActivate`, {}, auth)
}

let quota, policy, tools, llm, agent, oauth

before(async () => {
  quota = require('../srv/lib/quota')
  policy = require('../srv/lib/policy')
  tools = require('../srv/lib/tools')
  llm = require('../srv/lib/llm')
  agent = require('../srv/lib/agent')
  oauth = require('../srv/lib/oauth')
})

// ---------------------------------------------------------------------------
// Pure units — no server needed
// ---------------------------------------------------------------------------

describe('quota windows', () => {
  test('week starts on Monday', () => {
    // 2026-08-12 is a Wednesday.
    assert.equal(quota.periodStart('WEEK', new Date(2026, 7, 12)).getDate(), 10)
  })
  test('month starts on the 1st', () => {
    assert.equal(quota.periodStart('MONTH', new Date(2026, 7, 12)).getDate(), 1)
  })
  test('day window ends at midnight', () => {
    const end = quota.periodEnd('DAY', new Date(2026, 7, 12, 23, 50))
    assert.equal(end.getDate(), 13)
    assert.equal(end.getHours(), 0)
  })
})

describe('quota under concurrency', () => {
  // The technical design lists this as a non-functional requirement in its own
  // right: "rate-limit and cache lookups must be safe under concurrent
  // requests (atomic increment on UserConsumption)". A user who can exceed
  // their cap by asking twice at once defeats the cost control the product is
  // partly sold on, and nothing in the logs would show it.
  const countersFor = async (userID) => {
    const { Consumption } = cds.entities('factorypilot.token')
    return SELECT.from(Consumption).where({ userID, periodType: 'DAY' })
  }

  test('simultaneous first requests do not create rival counters', async () => {
    // The dangerous window is the very first request of a period: every
    // concurrent caller looks for a row, none exists yet, and each inserts its
    // own. readCounter is a SELECT.one, so it then sees one of several and
    // undercounts for the rest of the day.
    const user = `race-first-${Date.now()}`
    await Promise.all(Array.from({ length: 8 }, () => quota.checkAndReserve(user, [], 1)))

    const rows = await countersFor(user)
    assert.equal(rows.length, 1, `one counter per user per day, found ${rows.length}`)
    assert.equal(rows[0].consumedCount, 8, 'every concurrent request must be counted')
  })

  test('a limit is not exceeded by asking many times at once', async () => {
    // bob's seeded daily limit is 5. Twelve simultaneous requests must yield
    // exactly five allowances, not "however many raced through the check".
    const user = `race-limit-${Date.now()}`
    const { QuotaPolicy } = cds.entities('factorypilot.token')
    await INSERT.into(QuotaPolicy).entries({
      ID: cds.utils.uuid(),
      subject: user,
      dailyLimit: 5,
      weeklyLimit: 100,
      monthlyLimit: 1000,
      limitType: 'REQUEST_COUNT',
      overagePolicy: 'BLOCK',
      isActive: true,
    })

    const results = await Promise.all(Array.from({ length: 12 }, () => quota.checkAndReserve(user, [], 1)))
    const allowed = results.filter((r) => r.decision === 'ALLOWED').length

    assert.equal(allowed, 5, `the cap is 5; ${allowed} requests were allowed`)
    const rows = await countersFor(user)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].consumedCount, 5, 'denied requests must give back what they reserved')
  })
})

describe('filter templating', () => {
  test('substitutes today and warehouse', () => {
    const out = tools.buildFilter(
      "ActualGoodsMovementDate eq {today} and ShippingPoint eq '{warehouse}'",
      { datePreset: 'today', warehouseID: '1010' },
      'v2'
    )
    assert.match(out, /ActualGoodsMovementDate eq datetime'\d{4}-\d{2}-\d{2}T00:00:00'/)
    assert.match(out, /ShippingPoint eq '1010'/)
  })

  test('drops a clause whose placeholder cannot be resolved', () => {
    // Emitting `eq ''` would return zero rows and read as a real empty result.
    const out = tools.buildFilter(
      "ActualGoodsMovementDate eq {today} and ShippingPoint eq '{warehouse}'",
      { datePreset: 'today' },
      'v2',
      { warehouse: '' }
    )
    assert.ok(!out.includes("''"))
    assert.ok(!out.includes('ShippingPoint'))
  })

  test('v4 uses a bare ISO date', () => {
    const out = tools.buildFilter('D eq {today}', {}, 'v4')
    assert.match(out, /D eq \d{4}-\d{2}-\d{2}$/)
  })
})

describe('a provider that runs out of quota hands over, it does not give up', () => {
  // Free OpenRouter quota runs out partway through a day, and it runs out
  // mid-demo. The paid key has to be the next rung, not the last resort.

  const stub = (name, behaviour) => ({ name, complete: behaviour })
  const answers = (text) => async () => ({
    text, toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false,
  })
  const refuses = (message) => async () => { throw new llm.LLMError(message) }

  const withChain = async (chain, fn) => {
    const real = llm.getProviderChain
    llm.getProviderChain = () => chain
    try { return await fn() } finally { llm.getProviderChain = real }
  }

  const ask = (conversationID) => agent.run({
    question: 'hello',
    userID: 'tester',
    roles: [],
    conversationID,
    correlationId: 'x-chain',
    businessObjects: [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock', isActive: true }],
    route: null,
    orgSettings: {},
  })

  test('a rate-limited free model falls through to the paid one', async () => {
    const result = await withChain(
      [stub('openrouter', refuses('OpenRouter returned 429: rate limit exceeded')),
       stub('openai', answers('Answered by the paid key.')),
       new llm.FakeProvider('fallback')],
      () => ask('c-chain-1')
    )
    assert.equal(result.answer, 'Answered by the paid key.')
    assert.match(result.degradedFrom, /openrouter.*429/i, 'the audit must say which provider failed and why')
    assert.equal(result.status, 'SUCCESS')
  })

  test('it keeps descending rather than stopping at the first failure', async () => {
    const result = await withChain(
      [stub('openrouter', refuses('402 out of credits')),
       stub('openai', refuses('429 insufficient_quota')),
       new llm.FakeProvider('fallback')],
      () => ask('c-chain-2')
    )
    // Both failures recorded — an operator reading this can see the paid key is
    // also exhausted, which is the actionable half.
    assert.match(result.degradedFrom, /openrouter/)
    assert.match(result.degradedFrom, /openai/)
    assert.match(result.answer, /unavailable/i, 'and it must not invent an intent it cannot know')
  })

  test('a healthy first provider is used and nothing is recorded as degraded', async () => {
    const result = await withChain(
      [stub('openrouter', answers('Answered by the free model.')),
       stub('openai', answers('should not be reached'))],
      () => ask('c-chain-3')
    )
    assert.equal(result.answer, 'Answered by the free model.')
    assert.ok(!result.degradedFrom, 'nothing failed, so nothing to report')
  })
})

describe('a data question that got no lookup is asked once more', () => {
  // The free models call tools less reliably than a paid one, and a run that
  // quietly skipped the lookup looks exactly like one that had nothing to look
  // up — same green SUCCESS, same prose, but the figures came from the model's
  // weights rather than from SAP.

  const BO = [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock',
                keywords: 'stock,material stock,inventory level,on hand', isActive: true }]

  test('a warehouse question is retried, a greeting is not', () => {
    assert.equal(agent.matchesRegisteredObject('How much stock do we have?', BO), true)
    assert.equal(agent.matchesRegisteredObject('show me the inventory level', BO), true)
    assert.equal(agent.matchesRegisteredObject('what is your name?', BO), false)
    assert.equal(agent.matchesRegisteredObject('hello there', BO), false)
  })

  test('a keyword inside a longer word does not count', () => {
    // Substring matching would fire on "stocktaking", "restocking" and
    // "destocked" — wasting a SAP lookup on a question about none of them.
    assert.equal(agent.matchesRegisteredObject('what are the stocktaking rules?', BO), false)
    assert.equal(agent.matchesRegisteredObject('explain restocking policy', BO), false)
  })

  test('no registered object means never retry', () => {
    assert.equal(agent.matchesRegisteredObject('How much stock do we have?', []), false)
  })

  test('the model gets one more chance, and only one', async () => {
    // Two refusals is a decision, not an oversight — and looping would spend
    // the whole round budget on a model that has already declined.
    let asked = 0
    const stub = {
      name: 'stub',
      complete: async () => {
        asked++
        return { text: 'Roughly 3,000 units.', toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    }
    const real = llm.getProviderChain
    llm.getProviderChain = () => [stub]
    try {
      const result = await agent.run({
        question: 'How much stock do we have?',
        userID: 'tester', roles: [], conversationID: 'c-nudge', correlationId: 'x-nudge',
        businessObjects: BO, route: null, orgSettings: {},
      })
      assert.equal(asked, 2, 'asked once, nudged once, then accepted the answer')
      assert.equal(result.grounded, false, 'and it is still honestly reported as ungrounded')
      assert.equal(result.status, 'SUCCESS')
    } finally {
      llm.getProviderChain = real
    }
  })

  test('a greeting is answered first time, with no second call', async () => {
    let asked = 0
    const stub = {
      name: 'stub',
      complete: async () => {
        asked++
        return { text: 'Hello — I am FactoryPilot.', toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    }
    const real = llm.getProviderChain
    llm.getProviderChain = () => [stub]
    try {
      await agent.run({
        question: 'hello, what is your name?',
        userID: 'tester', roles: [], conversationID: 'c-greet', correlationId: 'x-greet',
        businessObjects: BO, route: null, orgSettings: {},
      })
      assert.equal(asked, 1, 'a greeting must not cost a second model call')
    } finally {
      llm.getProviderChain = real
    }
  })
})

describe('expand templating', () => {
  // SAP Graph exposes A_MaterialDocumentHeader but not A_MaterialDocumentItem,
  // and Plant lives on the item — so "movements in plant 1710" is only
  // expressible as a filter nested inside the $expand.
  const TPL =
    "to_MaterialDocumentItem($filter=Plant eq '{plant}' and Material eq '{materialID}';" +
    '$select=Material,Plant,GoodsMovementType)'

  test('placeholders are filled from the same values a filter uses', () => {
    const out = tools.buildExpand(TPL, { warehouseID: '1710', materialID: 'TG11' }, 'v4', {})
    assert.match(out, /\$filter=Plant eq '1710' and Material eq 'TG11'/)
    assert.match(out, /\$select=Material,Plant,GoodsMovementType/)
  })

  test('an unresolvable clause is dropped, not sent empty', () => {
    // `Material eq ''` matches nothing, and the answer reads as "there were no
    // movements" rather than "you did not name a material".
    const out = tools.buildExpand(TPL, { warehouseID: '1710' }, 'v4', {})
    assert.match(out, /\$filter=Plant eq '1710'/)
    assert.doesNotMatch(out, /Material eq ''/)
  })

  test('with nothing to filter on, the expand still fetches the children', () => {
    const out = tools.buildExpand(TPL, {}, 'v4', {})
    assert.doesNotMatch(out, /\$filter/)
    assert.match(out, /^to_MaterialDocumentItem\(\$select=/)
  })

  test('a bare navigation name passes through, and no expand stays empty', () => {
    assert.equal(tools.buildExpand('to_MaterialDocumentItem', {}, 'v4', {}), 'to_MaterialDocumentItem')
    assert.equal(tools.buildExpand('', {}, 'v4', {}), '')
    assert.equal(tools.buildExpand(null, {}, 'v4', {}), '')
  })
})

describe('approval policy merge', () => {
  test('most restrictive wins across layers', () => {
    // Verified against the seeded policies via the service tests below; this
    // guards the anomaly rule specifically.
    const quiet = policy.detectAnomaly({ quantity: 12 }, [10, 11, 9, 10])
    assert.equal(quiet.anomalous, false)

    const spike = policy.detectAnomaly({ quantity: 500 }, [10, 11, 9, 10])
    assert.equal(spike.anomalous, true)
    assert.match(spike.reason, /50\.0×/)
  })

  test('too little history to judge means not anomalous', () => {
    assert.equal(policy.detectAnomaly({ quantity: 9999 }, [10]).anomalous, false)
  })
})

describe('history sanitising', () => {
  test('drops an assistant tool call that never got a result', () => {
    // This is what an unconfirmed write leaves behind. Providers reject a
    // dangling tool call, so one would poison every later turn.
    const cleaned = agent.sanitiseHistory([
      { role: 'user', content: 'move stock' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a1' }] },
      { role: 'user', content: 'actually, how many deliveries?' },
    ])
    assert.deepEqual(cleaned.map((m) => m.role), ['user', 'user'])
  })

  test('keeps a tool call that was answered', () => {
    const cleaned = agent.sanitiseHistory([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a1' }] },
      { role: 'tool', tool_call_id: 'a1', content: '{}' },
    ])
    assert.equal(cleaned.length, 2)
  })

  test('drops an orphan tool result', () => {
    const cleaned = agent.sanitiseHistory([{ role: 'tool', tool_call_id: 'ghost', content: '{}' }])
    assert.equal(cleaned.length, 0)
  })
})

describe('offline provider tool choice', () => {
  test('prefers the tool the question opens with', async () => {
    // "shipping" is a longer keyword than "move", but the sentence is an
    // imperative to move — the write tool must win or the approval path is
    // never reached.
    const definitions = tools.buildDefinitions([
      { objectCode: 'DELIVERY', objectName: 'Outbound Delivery', keywords: 'delivery,shipping,warehouse' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'Move 250 units of P123 to shipping in warehouse 1000' }],
      tools: definitions,
    })
    assert.equal(res.toolCalls[0].name, 'move_stock')
  })

  test('calls a tool again on the next turn of the same conversation', async () => {
    // With history loaded, a tool result from the previous question must not
    // count as this question being answered — otherwise turn two silently
    // re-summarises stale data instead of calling a tool.
    const definitions = tools.buildDefinitions([
      { objectCode: 'DELIVERY', objectName: 'Outbound Delivery', keywords: 'delivery,deliveries,shipping' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [
        { role: 'user', content: 'How many deliveries today?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"rows":[]}' },
        { role: 'assistant', content: 'You have 0 records.' },
        { role: 'user', content: 'Move 250 units of P123 to shipping in warehouse 1000' },
      ],
      tools: definitions,
    })
    assert.equal(res.toolCalls.length, 1, 'turn two must call a tool of its own')
    assert.equal(res.toolCalls[0].name, 'move_stock')
  })

  test('an unreachable backend is not summarised as an empty result', async () => {
    // The model is handed {"error": ...} as the tool result and will narrate
    // around it. "No records matched" tells a supervisor there is no stock,
    // when in fact nothing was ever checked.
    const definitions = tools.buildDefinitions([
      { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [
        { role: 'user', content: 'How much stock do we have?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"error":"connect ECONNREFUSED"}' },
      ],
      tools: definitions,
    })
    assert.doesNotMatch(res.text, /no records matched/i, 'a failed fetch must not read as an empty result')
    assert.match(res.text, /could not reach/i)
  })

  test('a material number keeps the case the user typed', async () => {
    // The question is lowercased for keyword matching. Extracting the material
    // from that copy yields "p123", which matches no row in S/4 — the question
    // then answers "no records" for a material that is plainly in stock.
    const definitions = tools.buildDefinitions([
      { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material stock' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'How much stock do we have for P123?' }],
      tools: definitions,
    })
    assert.equal(res.toolCalls[0].arguments.materialID, 'P123')
  })

  test('a read with no material named is not narrowed to one', async () => {
    // Defaulting materialID on a read turns "how much stock do we have?" into
    // "how much P123 do we have?" — an authoritative-looking answer covering a
    // fraction of the data.
    const definitions = tools.buildDefinitions([
      { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material stock' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'How much stock do we have?' }],
      tools: definitions,
    })
    assert.equal(res.toolCalls[0].arguments.materialID, undefined)

    // A write with no material named is no longer completed with a guess. It
    // used to default to 'P123', so an operator could approve a goods movement
    // against a material they had never mentioned.
    const write = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'Move 40 units to shipping in warehouse 1000' }],
      tools: definitions,
    })
    assert.equal(write.toolCalls.length, 0, 'an incomplete write must not be proposed')
    assert.match(write.text, /which material/i)
  })

  test('each business object is summarised from its own fields', async () => {
    // Every object except DELIVERY used to report "N unknown", because the
    // summariser only knew the delivery status field.
    const cases = [
      // Field names as the live Hub returns them: one quantity column, with
      // InventoryStockType saying what kind of stock it is.
      [{ Material: 'P123', Plant: '1000', MaterialBaseUnit: 'EA', StorageLocation: '0001',
         InventoryStockType: '01', MatlWrhsStkQtyInMatlBaseUnit: '600' }, /600 units on hand/],
      [{ GoodsMovementType: '101', ReversedMaterialDocument: '' }, /goods receipts/],
      [{ PhysicalInventoryDocument: '1', Plant: '1010', PhysicalInventoryCountStatus: '', PhysInvtryAdjustmentPostingSts: '' }, /still to count/],
      [{ PurchaseOrder: '45', Supplier: '100002', PurchasingOrganization: '1010',
         PurchasingCompletenessStatus: '', PurchasingDocumentDeletionCode: '', DocumentCurrency: 'EUR' }, /still open/],
    ]
    for (const [row, expected] of cases) {
      const res = await new llm.FakeProvider().complete({
        messages: [
          { role: 'user', content: 'report' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
          { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ rows: [row] }) },
        ],
        tools: [],
      })
      assert.match(res.text, expected)
      assert.doesNotMatch(res.text, /unknown/, `${Object.keys(row)[0]} fell through to the status tally`)
    }
  })

  test('picks the read tool for a read question', async () => {
    const definitions = tools.buildDefinitions([
      { objectCode: 'DELIVERY', objectName: 'Outbound Delivery', keywords: 'delivery,deliveries,shipping' },
    ])
    const res = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'How many deliveries today?' }],
      tools: definitions,
    })
    assert.equal(res.toolCalls[0].name, 'query_delivery')
  })
})

describe('AI Core provider', () => {
  // No AI Core tenant in CI, so this is a contract test: it pins the parts of
  // the request that AI Core rejects when they are wrong, and that a live
  // smoke test would only tell us about after a deploy.
  const CONFIG = {
    baseUrl: 'https://api.ai.internalprod.eu-central-1.aws.ml.hana.ondemand.com/',
    deploymentId: 'd1234567890abcde',
    tokenUrl: 'https://client.authentication.eu10.hana.ondemand.com',
  }

  const okBody = {
    choices: [{ message: { content: 'Two deliveries are open.', tool_calls: [] } }],
    usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
  }
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })

  function withStubs(fetchImpl, run) {
    const realFetch = global.fetch
    const realGetToken = oauth.getToken
    let issued = 0
    global.fetch = fetchImpl
    oauth.getToken = async (_ep, { force = false } = {}) => `token-${force ? ++issued + 100 : ++issued}`
    return Promise.resolve(run()).finally(() => {
      global.fetch = realFetch
      oauth.getToken = realGetToken
    })
  }

  test('addresses the deployment and carries the resource group', async () => {
    let seen
    await withStubs(
      async (url, init) => { seen = { url, init }; return reply(200, okBody) },
      async () => {
        const res = await new llm.AICoreProvider(CONFIG).complete({ messages: [{ role: 'user', content: 'hi' }] })
        assert.equal(res.provider, 'aicore')
        assert.equal(res.totalTokens, 49)
        assert.equal(res.isEstimated, false)
      }
    )
    // The trailing slash on baseUrl must not produce a double slash, and the
    // path is scoped by deployment id — there is no model name in the body.
    assert.match(seen.url, /ondemand\.com\/v2\/inference\/deployments\/d1234567890abcde\/chat\/completions\?api-version=/)
    assert.equal(seen.init.headers['AI-Resource-Group'], 'default', 'AI Core 400s without this, and does not say so')
    assert.equal(seen.init.headers.Authorization, 'Bearer token-1')
    assert.equal(JSON.parse(seen.init.body).model, undefined)
  })

  test('a 401 is retried once with a freshly forced token', async () => {
    // A token cached across a credential rotation is inside its stated expiry
    // and still refused; without the retry every request fails until restart.
    const calls = []
    await withStubs(
      async (_url, init) => {
        calls.push(init.headers.Authorization)
        return calls.length === 1 ? reply(401, { message: 'unauthorized' }) : reply(200, okBody)
      },
      async () => {
        const res = await new llm.AICoreProvider(CONFIG).complete({ messages: [{ role: 'user', content: 'hi' }] })
        assert.equal(res.text, 'Two deliveries are open.')
      }
    )
    assert.deepEqual(calls, ['Bearer token-1', 'Bearer token-102'], 'the retry must not reuse the rejected token')
  })

  test('tools are offered, and tool calls come back parsed', async () => {
    await withStubs(
      async (_url, init) => {
        assert.equal(JSON.parse(init.body).tool_choice, 'auto')
        return reply(200, {
          choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'query_delivery', arguments: '{"warehouseID":"1000"}' } }] } }],
          usage: {},
        })
      },
      async () => {
        const res = await new llm.AICoreProvider(CONFIG).complete({
          messages: [{ role: 'user', content: 'deliveries?' }],
          tools: tools.buildDefinitions([{ objectCode: 'DELIVERY', objectName: 'Delivery', keywords: 'delivery' }]),
        })
        assert.equal(res.toolCalls[0].name, 'query_delivery')
        assert.deepEqual(res.toolCalls[0].arguments, { warehouseID: '1000' })
        assert.equal(res.isEstimated, true, 'no usage block means the count is an estimate')
      }
    )
  })

  test('refuses to construct without the settings it cannot work without', () => {
    assert.throws(() => new llm.AICoreProvider({ ...CONFIG, deploymentId: '' }), /AICORE_DEPLOYMENT_ID/)
  })

  test('getProvider wires the env through to a usable client', () => {
    // The names here are the contract with .env.example and cf set-env. A
    // mismatch between the two constructs nothing and falls back silently,
    // which looks identical to "no AI Core configured".
    const saved = { ...process.env }
    Object.assign(process.env, {
      LLM_PROVIDER: 'aicore',
      AICORE_BASE_URL: CONFIG.baseUrl,
      AICORE_DEPLOYMENT_ID: CONFIG.deploymentId,
      AICORE_TOKEN_URL: CONFIG.tokenUrl,
      AICORE_RESOURCE_GROUP: 'team-a',
    })
    try {
      const p = llm.getProvider({})
      assert.equal(p.name, 'aicore')
      assert.equal(p.resourceGroup, 'team-a')
      assert.match(p.url, /deployments\/d1234567890abcde\/chat\/completions/)
      assert.equal(p.tokenEndpoint.tokenUrl, `${CONFIG.tokenUrl}/oauth/token`)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  test('getProvider falls back rather than half-configuring AI Core', () => {
    // A route asking for aicore with no env set must not throw at question
    // time — the offline provider answers and the log says why.
    const saved = { ...process.env }
    delete process.env.LLM_PROVIDER
    delete process.env.AICORE_BASE_URL
    try {
      assert.equal(llm.getProvider({ provider: 'aicore' }).name, 'fake')
    } finally {
      Object.assign(process.env, saved)
    }
  })
})

describe('a run whose every tool call failed', () => {
  test('is FAILED, carries the reason, and says so in the answer', async () => {
    // Nothing was grounded and the fetch threw, so whatever the model chose to
    // narrate, this run did not answer the question. Reporting SUCCESS hides
    // the outage from anyone reading the audit log, and SUCCESS is also what
    // gates the answer cache — so the wrong answer would outlive the outage.
    const realExecuteRead = tools.executeRead
    tools.executeRead = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443')
    }
    try {
      const result = await agent.run({
        question: 'How much stock do we have?',
        userID: 'tester',
        roles: ['InsightsQuery'],
        warehouseID: '1000',
        conversationID: 'c-fail',
        correlationId: 'x-fail',
        businessObjects: [
          { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material', isActive: true },
        ],
        route: null,
        orgSettings: {},
      })
      assert.equal(result.status, 'FAILED')
      assert.equal(result.grounded, false)
      assert.match(result.errorDetail, /ECONNREFUSED/)
      assert.doesNotMatch(result.answer, /no records matched/i)
    } finally {
      tools.executeRead = realExecuteRead
    }
  })
})

describe('a question is bounded by wall-clock, not just by round count', () => {
  // MAX_ROUNDS=8 permits eight model calls plus their tool calls. Against a
  // 60s-per-call provider that outlasts any gateway, and the approuter answers
  // the user with a bare "HTTP 504" — no answer, no audit row, no explanation.
  // The run has to stop itself first.

  test('a deadline already passed stops the loop instead of running eight rounds', async () => {
    const realExecuteRead = tools.executeRead
    let toolCalls = 0
    tools.executeRead = async () => {
      toolCalls++
      return { rows: [{ Material: 'M1', MatlWrhsStkQtyInMatlBaseUnit: '5' }], url: 'https://example/x' }
    }
    try {
      const result = await agent.run({
        question: 'How much stock do we have?',
        userID: 'tester',
        roles: ['InsightsQuery'],
        warehouseID: '1010',
        conversationID: 'c-deadline',
        correlationId: 'x-deadline',
        businessObjects: [
          { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material', isActive: true },
        ],
        route: null,
        orgSettings: {},
        deadlineAt: Date.now() - 1,        // no time left at all
      })
      assert.equal(result.rounds, 1, 'should not start a second round past the deadline')
      assert.ok(result.timedOut, 'the run should record that it ran out of time')
      assert.match(result.answer, /longer than|ran out of time/i)
      // Running out of time must not be dressed up as an unreachable backend:
      // that sends the reader to hunt an outage that is not happening.
      assert.doesNotMatch(result.answer, /could not reach the source system/i)
      assert.doesNotMatch(result.answer, /no records matched/i)
      assert.notEqual(result.status, 'FAILED')
    } finally {
      tools.executeRead = realExecuteRead
      void toolCalls
    }
  })

  test('a generous deadline does not interfere', async () => {
    const realExecuteRead = tools.executeRead
    tools.executeRead = async () => ({
      rows: [{ Material: 'M1', MatlWrhsStkQtyInMatlBaseUnit: '5' }],
      url: 'https://example/x',
    })
    try {
      const result = await agent.run({
        question: 'How much stock do we have?',
        userID: 'tester',
        roles: ['InsightsQuery'],
        warehouseID: '1010',
        conversationID: 'c-roomy',
        correlationId: 'x-roomy',
        businessObjects: [
          { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,material', isActive: true },
        ],
        route: null,
        orgSettings: {},
        deadlineAt: Date.now() + 120000,
      })
      assert.ok(!result.timedOut, 'a run with time to spare must not report a timeout')
      assert.equal(result.grounded, true)
    } finally {
      tools.executeRead = realExecuteRead
    }
  })

  test('the provider is told how much time is left, not its own default', async () => {
    // Otherwise a single 60s model call spends the whole budget and the
    // deadline check never gets a turn.
    const captured = []
    const stub = {
      name: 'stub',
      complete: async (payload) => {
        captured.push(payload.timeoutMs)
        return { text: 'ok', toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    }
    const realGetChain = llm.getProviderChain
    llm.getProviderChain = () => [stub]
    try {
      await agent.run({
        question: 'hello',
        userID: 'tester',
        roles: [],
        conversationID: 'c-budget',
        correlationId: 'x-budget',
        businessObjects: [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock', isActive: true }],
        route: null,
        orgSettings: {},
        deadlineAt: Date.now() + 20000,
      })
      assert.equal(captured.length, 1)
      assert.ok(captured[0] < 20000, `expected a ceiling under the 20s budget, got ${captured[0]}`)
      assert.ok(captured[0] > 1000, `expected a usable ceiling, got ${captured[0]}`)
    } finally {
      llm.getProviderChain = realGetChain
    }
  })

  test('with no deadline the provider keeps its own timeout', async () => {
    const captured = []
    const stub = {
      name: 'stub',
      complete: async (payload) => {
        captured.push(payload.timeoutMs)
        return { text: 'ok', toolCalls: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, isEstimated: false }
      },
    }
    const realGetChain = llm.getProviderChain
    llm.getProviderChain = () => [stub]
    try {
      await agent.run({
        question: 'hello',
        userID: 'tester',
        roles: [],
        conversationID: 'c-nodeadline',
        correlationId: 'x-nodeadline',
        businessObjects: [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock', isActive: true }],
        route: null,
        orgSettings: {},
      })
      assert.equal(captured[0], undefined, 'no deadline means no ceiling to impose')
    } finally {
      llm.getProviderChain = realGetChain
    }
  })
})

// ---------------------------------------------------------------------------
// Services — against a running CAP instance
// ---------------------------------------------------------------------------

const ADMIN = { auth: { username: 'admin', password: 'admin' } }
const BOB = { auth: { username: 'bob', password: 'bob' } }
const VIEWER = { auth: { username: 'viewer', password: 'viewer' } }

describe('ConfigService', () => {
  test('serves the seeded registry', async () => {
    const { data: res } = await GET('/odata/config/BusinessObjects?$select=objectCode,isActive', ADMIN)
    const codes = res.value.map((r) => r.objectCode)
    for (const seeded of ['DELIVERY', 'MATERIAL_STOCK', 'MATERIAL_DOCUMENT', 'PHYSICAL_INVENTORY', 'PURCHASING']) {
      assert.ok(codes.includes(seeded), `${seeded} should be registered`)
    }
  })

  test('ToolCatalog exposes only active, tool-enabled objects', async () => {
    const { data: res } = await GET('/odata/config/ToolCatalog', ADMIN)
    // Only DELIVERY is seeded active; other tests may add inactive rows.
    assert.ok(res.value.map((r) => r.objectCode).includes('DELIVERY'))
    assert.ok(res.value.length >= 5, 'the live objects should all be exposed as tools')
  })

  test('a viewer cannot write configuration', async () => {
    await assert.rejects(
      () => POST('/odata/config/BusinessObjects', { objectCode: 'NOPE', objectName: 'x' }, VIEWER),
      (err) => err.response?.status === 403
    )
  })

  test('activating without a service path is refused', async () => {
    await assert.rejects(
      () => createActive('/odata/config/BusinessObjects', 'ConfigService', { objectCode: 'BAD', isActive: true }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('a credentialRef that looks like a secret is refused', async () => {
    // Storing the key itself would put it in the database and every export of
    // that table. The field takes the NAME of an env var.
    await assert.rejects(
      () => createActive('/odata/integration/Endpoints', 'IntegrationService', { name: `leaky ${Date.now()}`, kind: 'iflow', url: 'https://x.example.com', credentialRef: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345' }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('an http endpoint is refused — credentials would go in clear', async () => {
    await assert.rejects(
      () => createActive('/odata/integration/Endpoints', 'IntegrationService', { name: `insecure ${Date.now()}`, kind: 'iflow', url: 'http://cpi.example.com/flow' }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('an iFlow endpoint can be registered by URL alone', async () => {
    // This is the point of the service: connecting an iFlow is data entry.
    const { data } = await POST('/odata/integration/Endpoints', {
      name: `Customer iFlow ${Date.now()}`, kind: 'iflow',
      url: 'https://my-tenant.it-cpi001.cfapps.eu10.hana.ondemand.com/http/s4/odata/query',
      authMode: 'bearer', credentialRef: 'CUSTOMER_IFLOW_TOKEN',
    }, ADMIN)
    assert.equal(data.kind, 'iflow')
    assert.equal(data.isActive, true)
  })

  test('testing an unreachable endpoint records the failure rather than throwing', async () => {
    // Saved first, then tested — the same order an admin works in, and the
    // only order available now that the entity is draft-enabled: a bound action
    // needs a row, and a draft is not one yet.
    const { data: created } = await createActive('/odata/integration/Endpoints', 'IntegrationService', {
      name: `Unreachable ${Date.now()}`, kind: 'iflow', url: 'https://127.0.0.1:9/nope', timeoutMs: 900,
    }, ADMIN)
    const { data: result } = await POST(
      `/odata/integration/Endpoints(ID=${created.ID},IsActiveEntity=true)/IntegrationService.test`, {}, ADMIN)
    assert.ok(['FAILED', 'UNCONFIGURED'].includes(result.status))
    assert.ok(result.message.length > 0, 'the admin needs to be told why')
  })
})

describe('an administrator can actually maintain the configuration', () => {
  // The Admin screens were read-only: every list rendered, nothing could be
  // created or changed, because none of these entities were draft-enabled and
  // Fiori Elements has no edit flow without it. These tests exercise the same
  // create-then-activate path the screens now use, so "the admin can manage it"
  // is a checked claim rather than a screenshot.

  const CASES = [
    { what: 'a quota',         path: '/odata/token/QuotaPolicies',  svc: 'TokenService',
      make: () => ({ subject: `team-${Date.now()}`, dailyLimit: 25, weeklyLimit: 100, monthlyLimit: 300 }),
      change: { dailyLimit: 40 }, check: (r) => r.dailyLimit === 40 },
    { what: 'a model route',   path: '/odata/token/ModelRoutes',    svc: 'TokenService',
      make: () => ({ route: `custom-${Date.now()}`, provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', maxTokens: 900 }),
      change: { maxTokens: 1500 }, check: (r) => r.maxTokens === 1500 },
    { what: 'a user',          path: '/odata/admin/Users',          svc: 'AdminService',
      make: () => ({ userID: `starter-${Date.now()}`, displayName: 'New Starter', isActive: true }),
      change: { displayName: 'Renamed Starter' }, check: (r) => r.displayName === 'Renamed Starter' },
    { what: 'an approval policy', path: '/odata/admin/ApprovalPolicies', svc: 'AdminService',
      make: () => ({ scopeKind: 'USER', subject: `u-${Date.now()}`, autoApproveWrites: false, writeCeiling: 10 }),
      change: { writeCeiling: 25 }, check: (r) => r.writeCeiling === 25 },
    { what: 'a business object', path: '/odata/config/BusinessObjects', svc: 'ConfigService',
      make: () => ({ objectCode: `OBJ${Date.now()}`.slice(0, 28), objectName: 'Ad hoc', isActive: false }),
      change: { objectName: 'Renamed' }, check: (r) => r.objectName === 'Renamed' },
  ]

  for (const c of CASES) {
    test(`creates and edits ${c.what}`, async () => {
      const { data: made } = await createActive(c.path, c.svc, c.make(), ADMIN)
      assert.ok(made.ID, `${c.what} should come back with an ID`)

      // Editing goes through a draft too: open one, change it, activate it.
      await POST(`${c.path}(ID=${made.ID},IsActiveEntity=true)/${c.svc}.draftEdit`, { PreserveChanges: true }, ADMIN)
      await PATCH(`${c.path}(ID=${made.ID},IsActiveEntity=false)`, c.change, ADMIN)
      const { data: saved } = await POST(`${c.path}(ID=${made.ID},IsActiveEntity=false)/${c.svc}.draftActivate`, {}, ADMIN)
      assert.ok(c.check(saved), `${c.what} should show the edit: ${JSON.stringify(c.change)}`)
    })
  }

  test('a business user cannot maintain configuration', async () => {
    // Draft or not, the scope still decides. An edit flow that quietly widened
    // who may change a quota would be a worse bug than no edit flow at all.
    await assert.rejects(
      () => POST('/odata/token/QuotaPolicies', { subject: 'sneaky', dailyLimit: 9999 }, BOB),
      (err) => err.response?.status === 403
    )
    await assert.rejects(
      () => POST('/odata/admin/Users', { userID: 'sneaky', displayName: 'x' }, BOB),
      (err) => err.response?.status === 403
    )
  })
})

describe('AdminService policy resolution', () => {
  test('org denial beats a permissive warehouse policy', async () => {
    const { data: res } = await GET("/odata/admin/effectivePolicy(userID='bob',warehouseID='1000')", ADMIN)
    assert.equal(res.autoApproveWrites, false, 'ORG forbids auto-writes, so warehouse 1000 cannot grant them')
    assert.equal(res.writeCeiling, 100, 'the tightest ceiling across layers applies')
  })

  test('second-approver requirement propagates from the warehouse', async () => {
    const { data: res } = await GET("/odata/admin/effectivePolicy(userID='bob',warehouseID='1010')", ADMIN)
    assert.equal(res.requireSecondApprover, true)
  })

  test('write scope is per warehouse', async () => {
    const { data: yes } = await GET("/odata/admin/canWrite(userID='bob',warehouseID='1000')", ADMIN)
    const { data: no } = await GET("/odata/admin/canWrite(userID='bob',warehouseID='1010')", ADMIN)
    assert.equal(yes.value, true)
    assert.equal(no.value, false, 'a read scope is not a weak write scope')
  })
})

describe('TokenService', () => {
  test('reports the caller their own limits', async () => {
    const { data: res } = await GET('/odata/token/myUsage()', BOB)
    assert.equal(res.userID, 'bob')
    assert.equal(res.limitDay, 5)
  })

  test('a weekly limit below the daily one is refused', async () => {
    await assert.rejects(
      () => createActive('/odata/token/QuotaPolicies', 'TokenService', { subject: 'x', dailyLimit: 100, weeklyLimit: 10 }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('one user cannot reserve against another user’s quota', async () => {
    await assert.rejects(
      () => POST('/odata/token/checkAndReserve', { subject: 'admin', estimatedTokens: 10 }, BOB),
      (err) => err.response?.status === 403
    )
  })
})

describe('InsightsService agent loop', () => {
  // bob's seeded limit is 5/day on purpose — it is what the quota demo uses.
  // Clear his counters between tests so these exercise the loop rather than
  // the limit, which has its own test above.
  beforeEach(async () => {
    await cds.db.run(DELETE.from('factorypilot.token.Consumption').where({ userID: 'bob' }))
  })

  test('answers a read question from real tool output', async () => {
    const { data: res } = await POST(
      '/insights/ask',
      { question: 'How many deliveries today in warehouse 1000?', warehouseID: '1000' },
      BOB
    )
    assert.equal(res.status, 'SUCCESS')
    assert.equal(res.metadata.objectCode, 'DELIVERY')
    assert.equal(res.metadata.grounded, true, 'the answer came from a tool, not model recall')
    assert.equal(res.metadata.toolsCalled, 'query_delivery')
    assert.ok(res.metadata.tokensUsed > 0)
    // The wording differs once a result is sampled — it then quotes the true
    // total and says how many rows were examined — so match the stable part.
    assert.match(res.answer, /record\(s\) match/)
  })

  test('a write is proposed, never executed inline', async () => {
    const { data: res } = await POST(
      '/insights/ask',
      { question: 'Move 20 units of P123 from packing to shipping in warehouse 1000', warehouseID: '1000' },
      BOB
    )
    assert.equal(res.status, 'AWAITING_APPROVAL')
    assert.ok(res.pendingAction?.actionID)
    assert.match(res.pendingAction.summary, /Move 20/)
  })

  test('confirming runs it exactly once', async () => {
    const { data: proposed } = await POST(
      '/insights/ask',
      { question: 'Move 30 units of P123 from packing to shipping in warehouse 1000', warehouseID: '1000' },
      BOB
    )
    const actionID = proposed.pendingAction.actionID

    const { data: first } = await POST('/insights/confirmAction', { actionID, approve: true }, BOB)
    assert.equal(first.status, 'SUCCESS')

    // A double-click must not post the goods movement twice.
    const { data: replay } = await POST('/insights/confirmAction', { actionID, approve: true }, BOB)
    assert.equal(replay.status, 'ERROR')
    assert.equal(replay.errorCode, 'ACTION_EXPIRED')
  })

  test('a caller who has never been seen is provisioned, but granted nothing', async () => {
    // Identity comes from the token, so every real user arrives with no row.
    // They were invisible in the Admin console, which is where someone has to
    // go to grant them warehouse scope — a deadlock.
    const NEW = { auth: { username: 'newstarter', password: 'newstarter' } }
    await POST('/insights/ask', { question: 'How many deliveries today?', warehouseID: '1000' }, NEW)

    const { data: users } = await GET("/odata/admin/Users?$filter=userID eq 'newstarter'", ADMIN)
    assert.equal(users.value.length, 1, 'first question must make the caller visible to an administrator')
    assert.equal(users.value[0].isAdmin, false, 'being seen must not confer admin')

    // Visible, but still powerless — a write is refused until scope is granted.
    const { data: proposed } = await POST(
      '/insights/ask',
      { question: 'Move 15 units of P123 from packing to shipping in warehouse 1000', warehouseID: '1000' },
      NEW
    )
    const { data: denied } = await POST(
      '/insights/confirmAction',
      { actionID: proposed.pendingAction.actionID, approve: true },
      NEW
    )
    assert.equal(denied.errorCode, 'SCOPE_DENIED')
  })

  test('a platform administrator is not locked out of their own system', async () => {
    // This is what broke the end-to-end demo: the BTP role collection grants
    // OAuth scopes but creates no row here, so canWrite refused every write —
    // including for the person who administers the subaccount, whose only
    // remedy was editing a table they could not reach.
    const NEWADMIN = { auth: { username: 'newadmin', password: 'newadmin' } }
    const { data: proposed } = await POST(
      '/insights/ask',
      { question: 'Move 25 units of P123 from packing to shipping in warehouse 1000', warehouseID: '1000' },
      NEWADMIN
    )
    const { data: done } = await POST(
      '/insights/confirmAction',
      { actionID: proposed.pendingAction.actionID, approve: true },
      NEWADMIN
    )
    assert.equal(done.status, 'SUCCESS', done.message || '')
  })

  test('rejecting changes nothing', async () => {
    const { data: proposed } = await POST(
      '/insights/ask',
      { question: 'Move 40 units of P123 to shipping in warehouse 1000', warehouseID: '1000' },
      BOB
    )
    const { data: res } = await POST(
      '/insights/confirmAction',
      { actionID: proposed.pendingAction.actionID, approve: false },
      BOB
    )
    assert.equal(res.status, 'SUCCESS')
    assert.match(res.answer, /Nothing was changed/)
  })

  test('maker cannot be checker where policy demands a second approver', async () => {
    const { data: proposed } = await POST(
      '/insights/ask',
      { question: 'Move 5 units of P123 to shipping in warehouse 1010', warehouseID: '1010' },
      BOB
    )
    const { data: res } = await POST(
      '/insights/confirmAction',
      { actionID: proposed.pendingAction.actionID, approve: true },
      BOB
    )
    assert.equal(res.errorCode, 'SECOND_APPROVER_REQUIRED')
  })

  test('every request leaves exactly one audit row', async () => {
    const { data: before } = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    await POST('/insights/ask', { question: 'How many deliveries today in warehouse 1000?' }, BOB)
    const { data: after } = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    assert.equal(Number(after), Number(before) + 1)
  })

  test('an unmatched question still writes an audit row', async () => {
    const { data: before } = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    const { data: res } = await POST('/insights/ask', { question: 'what is the weather in Berlin' }, BOB)
    assert.equal(res.status, 'SUCCESS') // the model answers that it cannot match
    const { data: after } = await GET('/odata/audit/SessionLogs/$count', ADMIN)
    assert.equal(Number(after), Number(before) + 1)
  })
})

describe('AuditService', () => {
  test('logs are read-only over OData', async () => {
    await assert.rejects(
      () => POST('/odata/audit/SessionLogs', { userID: 'forged', status: 'SUCCESS' }, ADMIN),
      (err) => err.response?.status === 405 || err.response?.status === 403
    )
  })

  test('feedback is attributed to the caller, not the payload', async () => {
    await POST('/odata/audit/Feedbacks', { userID: 'someone-else', rating: 5 }, BOB)
    const rows = await cds.db.run(SELECT.from('factorypilot.audit.Feedback').where({ rating: 5 }))
    assert.ok(rows.length > 0, 'the feedback row should exist')
    assert.ok(
      rows.every((r) => r.userID === 'bob'),
      'a forged userID in the payload must be overwritten with the caller'
    )
  })

  test('an out-of-range rating is refused', async () => {
    await assert.rejects(
      () => POST('/odata/audit/Feedbacks', { rating: 99 }, BOB),
      (err) => err.response?.status === 400
    )
  })
})

describe('quota under heavy concurrency', () => {
  test('a cap of 5 holds against 60 simultaneous requests', async () => {
    // Twelve was enough to expose the bug; sixty is the confidence that the
    // fix is the database enforcing the cap rather than a timing accident.
    const user = `race-heavy-${Date.now()}`
    const { QuotaPolicy, Consumption } = cds.entities('factorypilot.token')
    await INSERT.into(QuotaPolicy).entries({
      ID: cds.utils.uuid(), subject: user,
      dailyLimit: 5, weeklyLimit: 1000, monthlyLimit: 10000,
      limitType: 'REQUEST_COUNT', overagePolicy: 'BLOCK', isActive: true,
    })

    const results = await Promise.all(Array.from({ length: 60 }, () => quota.checkAndReserve(user, [], 1)))
    const allowed = results.filter((r) => r.decision === 'ALLOWED').length
    assert.equal(allowed, 5, `${allowed} of 60 were allowed against a cap of 5`)

    const day = await SELECT.one.from(Consumption).where({ userID: user, periodType: 'DAY' })
    assert.equal(day.consumedCount, 5, 'the counter must match what was allowed')

    // The 55 refusals must not have left their week/month reservations behind.
    const week = await SELECT.one.from(Consumption).where({ userID: user, periodType: 'WEEK' })
    assert.equal(week.consumedCount, 5, 'refused requests must give back every window they reserved')
  })
})

describe('model routing', () => {
  // "Use a big model when the question needs one" is only half of it. The
  // other half is that a lookup must not cost what analysis costs, and that
  // under load everything gets cheaper rather than slower.
  let router
  before(async () => { router = require('../srv/lib/route') })

  test('a lookup is light, analysis is heavy', () => {
    for (const q of [
      'How much stock do we have?',
      'What purchase orders are open?',
      'deliveries today',
    ]) assert.equal(router.complexityOf(q), 'light', q)

    for (const q of [
      'Compare stock this week versus last week',
      'Why did goods movements drop in plant 1010?',
      'Summarise purchase orders grouped by supplier',
      'What changed across the last three counts?',
    ]) assert.equal(router.complexityOf(q), 'heavy', q)
  })

  test('a write is never routed light', () => {
    // The card a write produces is read by a human about to change a real
    // system, so it is worth the better model regardless of sentence length.
    assert.equal(router.complexityOf('Move 250 units of P123 to shipping'), 'heavy')
  })

  test('a rambling question is treated as analysis', () => {
    const long = 'I want to understand ' + 'the situation with our stock levels and movements '.repeat(3) + 'please'
    assert.equal(router.complexityOf(long), 'heavy')
  })

  test('picks a real seeded route and explains the choice', async () => {
    // load is pinned: otherwise the suite's own audit traffic trips the
    // busy-downgrade and this asserts against whatever ran before it.
    const light = await router.pick({ question: 'How much stock do we have?', load: 0 })
    assert.equal(light.chosen, 'light')
    assert.ok(light.route?.model, 'the light route must resolve to a configured model')

    const heavy = await router.pick({ question: 'Compare this week with last week and explain why', load: 0 })
    assert.equal(heavy.chosen, 'heavy')
    assert.ok(heavy.route?.model, 'the heavy route must resolve to a configured model')
    // The two routes may share a model — what must differ is the budget, since
    // that is what makes a lookup cheaper than an analysis.
    assert.ok(
      heavy.route.maxTokens > light.route.maxTokens,
      `heavy (${heavy.route.maxTokens}) must allow more than light (${light.route.maxTokens})`
    )
  })

  test('under load, analysis is answered by the light model instead of failing', async () => {
    // Capacity is shared. Plainer prose for everyone beats timeouts for the
    // unlucky — and the numbers come from the same tool output either way.
    const q = 'Compare this week with last week and explain why'
    const busy = await router.pick({ question: q, load: router.BUSY_THRESHOLD })
    assert.equal(busy.chosen, 'light')
    assert.match(busy.why, /requests in the last 5 minutes/)

    const quiet = await router.pick({ question: q, load: router.BUSY_THRESHOLD - 1 })
    assert.equal(quiet.chosen, 'heavy', 'just below the threshold must still get the better model')
  })

  test('an operator override wins over the heuristic', async () => {
    const out = await router.pick({ question: 'How much stock do we have?', forced: 'heavy' })
    assert.equal(out.chosen, 'heavy')
    assert.match(out.why, /forced/i)
  })
})

describe('reasoning leakage', () => {
  // Nemotron and friends think out loud. Excluding reasoning at the API is
  // ignored by some models once tools are in play, so the answer arrives
  // opening with "We need to analyse the data returned…" — the operator reads
  // the deliberation instead of the number.
  test('a deliberation preamble is removed', () => {
    const leaked = 'We have a large dataset. The user asks how much stock. ' +
                   'We need to summarise across materials. Total stock is 2,182,001,094 units across 12 materials.'
    const out = agent.stripDeliberation(leaked)
    assert.match(out, /^Total stock is/)
    assert.doesNotMatch(out, /We need to/)
  })

  test('a real answer that happens to start with "We" is left alone', () => {
    // The strip must not eat a legitimate answer. "We have 42 open orders" is
    // the answer, not a preamble.
    const real = 'We have 42 open purchase orders worth 1.2M EUR.'
    assert.equal(agent.stripDeliberation(real), real)
  })

  test('an answer that is entirely deliberation is returned rather than emptied', () => {
    const allThinking = 'We need to check the data. I should look at the rows.'
    assert.ok(agent.stripDeliberation(allThinking).length > 0, 'never return an empty answer')
  })
})

describe('the fallback does not invent an intent', () => {
  // The deterministic provider does two jobs. Offline it is a feature: keyword
  // tool-picking makes the product demonstrable with no key. Standing in for a
  // model that failed it is a liability — "what is your name" came back
  // "I could not match that question to a registered business object", and
  // anything brushing a keyword came back "0 records". Both read as a broken
  // product rather than an unavailable model.
  const definitions = () => tools.buildDefinitions([
    { objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', keywords: 'stock,inventory,how much' },
  ])

  test('offline still picks a tool — that is what makes the demo work', async () => {
    const res = await new llm.FakeProvider('offline').complete({
      messages: [{ role: 'user', content: 'How much stock do we have?' }],
      tools: definitions(),
    })
    assert.equal(res.toolCalls[0].name, 'query_material_stock')
  })

  test('as a fallback it calls no tool and says the model is unavailable', async () => {
    for (const q of ['whats your name?', 'How much stock do we have?', 'who built you?']) {
      const res = await new llm.FakeProvider('fallback').complete({
        messages: [{ role: 'user', content: q }],
        tools: definitions(),
      })
      assert.equal(res.toolCalls.length, 0, `${q} must not fabricate a tool call`)
      assert.match(res.text, /model is unavailable/i)
      assert.doesNotMatch(res.text, /could not match that question/i)
    }
  })

  test('the default role stays offline, so nothing else changes behaviour', async () => {
    const res = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'How much stock do we have?' }],
      tools: definitions(),
    })
    assert.equal(res.toolCalls.length, 1)
  })
})

describe('a sample is never reported as a total', () => {
  // agent.js caps the rows it sends the model, so every figure the offline
  // summariser computes is a sample statistic. Presenting one as the
  // population total understated stock roughly eightfold with no caveat —
  // "2500 units on hand" for a 25-row sample of 200 matching records.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({
    Material: 'M' + i, Plant: '1010', StorageLocation: '101B',
    InventoryStockType: '01', MaterialBaseUnit: 'EA', MatlWrhsStkQtyInMatlBaseUnit: '100',
  }))
  const answer = (payload) => new llm.FakeProvider('offline').complete({
    messages: [
      { role: 'user', content: 'How much stock do we have?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(payload) },
    ],
    tools: [],
  }).then((r) => r.text)

  test('a truncated result says so and quotes the real total', async () => {
    const text = await answer({ rows: rows(25), rowCount: 200, returned: 25, truncated: true })
    assert.match(text, /25 of 200/)
    assert.match(text, /sample, not the full total/i)
  })

  test('a complete result carries no caveat', async () => {
    const text = await answer({ rows: rows(25), rowCount: 25, returned: 25, truncated: false })
    assert.doesNotMatch(text, /sample/i)
  })

  test('an empty result names the query instead of asserting a period', async () => {
    // "for the requested period and location" claimed a period and a location
    // that may never have been part of the filter, so a plant with no stock
    // and a plant nobody queried read identically.
    const text = await answer({ rows: [], rowCount: 0, queriedWith: "Plant eq '1000'" })
    assert.match(text, /Plant eq '1000'/)
    assert.doesNotMatch(text, /requested period/i)
  })
})

describe('a write is never proposed with invented values', () => {
  const defs = () => tools.buildDefinitions([
    { objectCode: 'MATERIAL_STOCK', objectName: 'Stock', keywords: 'stock' },
  ])
  const ask = (q) => new llm.FakeProvider('offline').complete({
    messages: [{ role: 'user', content: q }], tools: defs(),
  })

  test('a plant number is not read as a quantity', async () => {
    // "from plant 1010 to 1710" previously proposed moving 1010 units.
    const r = await ask('Move stock of P123 from plant 1010 to 1710')
    assert.equal(r.toolCalls.length, 0)
    assert.match(r.text, /how many/i)
  })

  test('a missing quantity is asked for, not defaulted to 1', async () => {
    const r = await ask('Move some P123 to shipping')
    assert.equal(r.toolCalls.length, 0)
    assert.match(r.text, /how many/i)
  })

  test('a missing material is asked for, not invented', async () => {
    // This produced an approval card naming P123 — a material the operator
    // never mentioned — which, approved, posts a goods movement against it.
    const r = await ask('Move 50 units from 0001 to 0002')
    assert.equal(r.toolCalls.length, 0)
    assert.match(r.text, /which material/i)
    assert.doesNotMatch(r.text, /P123/)
  })

  test('a fully stated write is still proposed', async () => {
    const r = await ask('Move 250 units of P123 to shipping in warehouse 1010')
    assert.equal(r.toolCalls[0].name, 'move_stock')
    assert.deepEqual(r.toolCalls[0].arguments, { warehouseID: '1010', quantity: 250, materialID: 'P123' })
  })
})
