const { test, describe, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')

// In-memory SQLite per run: the tests own their data and never touch the
// developer's db/factorypilot.db.
const { GET, POST, expect: _unused, data } = cds.test(PROJECT).in(PROJECT)

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

    // The write tool still needs one: materialID is required there, so a
    // missing value cannot be expressed and the confirmation card needs it.
    const write = await new llm.FakeProvider().complete({
      messages: [{ role: 'user', content: 'Move 40 units to shipping in warehouse 1000' }],
      tools: definitions,
    })
    assert.equal(write.toolCalls[0].name, 'move_stock')
    assert.ok(write.toolCalls[0].arguments.materialID, 'a write must carry a material')
  })

  test('each business object is summarised from its own fields', async () => {
    // Every object except DELIVERY used to report "N unknown", because the
    // summariser only knew the delivery status field.
    const cases = [
      [{ Material: 'P123', MaterialName: 'Pump', Plant: '1000', MaterialBaseUnit: 'EA',
         MatlStkQtyInMatlBaseUnitUnrestricted: '600', MatlStkQtyInMatlBaseUnitBlocked: '10',
         MatlStkQtyInMatlBaseUnitInQualityInsp: '5' }, /600 units are unrestricted/],
      [{ GoodsMovementType: '101', ReversedMaterialDocument: '' }, /goods receipts/],
      [{ PhysicalInventoryDocument: '1', PhysInventoryCountIsCompleted: false, PhysicalInventoryIsPosted: false }, /still to count/],
      [{ PurchaseOrder: '45', SupplierName: 'Nordic Steel AB', PurchaseOrderNetAmount: '1000',
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
      () => POST('/odata/config/BusinessObjects', { objectCode: 'BAD', isActive: true }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('a credentialRef that looks like a secret is refused', async () => {
    // Storing the key itself would put it in the database and every export of
    // that table. The field takes the NAME of an env var.
    await assert.rejects(
      () => POST('/odata/integration/Endpoints', { name: `leaky ${Date.now()}`, kind: 'iflow', url: 'https://x.example.com', credentialRef: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345' }, ADMIN),
      (err) => err.response?.status === 400
    )
  })

  test('an http endpoint is refused — credentials would go in clear', async () => {
    await assert.rejects(
      () => POST('/odata/integration/Endpoints', { name: `insecure ${Date.now()}`, kind: 'iflow', url: 'http://cpi.example.com/flow' }, ADMIN),
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
    const { data: created } = await POST('/odata/integration/Endpoints', {
      name: `Unreachable ${Date.now()}`, kind: 'iflow', url: 'https://127.0.0.1:9/nope', timeoutMs: 900,
    }, ADMIN)
    const { data: result } = await POST(`/odata/integration/Endpoints(${created.ID})/IntegrationService.test`, {}, ADMIN)
    assert.ok(['FAILED', 'UNCONFIGURED'].includes(result.status))
    assert.ok(result.message.length > 0, 'the admin needs to be told why')
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
      () => POST('/odata/token/QuotaPolicies', { subject: 'x', dailyLimit: 100, weeklyLimit: 10 }, ADMIN),
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
    assert.match(res.answer, /record\(s\) matching/)
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
