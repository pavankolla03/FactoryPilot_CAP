const { test, describe, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')

// In-memory SQLite per run: the tests own their data and never touch the
// developer's db/factorypilot.db.
const { GET, POST, expect: _unused, data } = cds.test(PROJECT).in(PROJECT)

let quota, policy, tools, llm, agent

before(async () => {
  quota = require('../srv/lib/quota')
  policy = require('../srv/lib/policy')
  tools = require('../srv/lib/tools')
  llm = require('../srv/lib/llm')
  agent = require('../srv/lib/agent')
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

// ---------------------------------------------------------------------------
// Services — against a running CAP instance
// ---------------------------------------------------------------------------

const ADMIN = { auth: { username: 'admin', password: 'admin' } }
const BOB = { auth: { username: 'bob', password: 'bob' } }
const VIEWER = { auth: { username: 'viewer', password: 'viewer' } }

describe('ConfigService', () => {
  test('serves the seeded registry', async () => {
    const { data: res } = await GET('/odata/config/BusinessObjects?$select=objectCode,isActive', ADMIN)
    const codes = res.value.map((r) => r.objectCode).sort()
    assert.deepEqual(codes, ['DELIVERY', 'GOODS_MOVEMENT', 'PURCHASING', 'SALES', 'SHIPPING'])
  })

  test('ToolCatalog exposes only active, tool-enabled objects', async () => {
    const { data: res } = await GET('/odata/config/ToolCatalog', ADMIN)
    assert.deepEqual(res.value.map((r) => r.objectCode), ['DELIVERY'])
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
    // Storing the key itself here would put it in the database and every audit
    // export of it.
    await assert.rejects(
      () => POST('/odata/config/Connections', { name: 'leaky', credentialRef: 'sk-or-v1-abc123' }, ADMIN),
      (err) => err.response?.status === 400
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
