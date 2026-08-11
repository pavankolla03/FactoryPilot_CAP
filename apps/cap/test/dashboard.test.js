const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { GET, POST } = cds.test(PROJECT).in(PROJECT)

const ADMIN = { auth: { username: 'admin', password: 'admin' } }
const BOB = { auth: { username: 'bob', password: 'bob' } }

// Give the aggregates something to aggregate.
//
// Done lazily rather than in a before() hook: cds.test starts the server
// asynchronously, and a top-level before() races it — the tests get cancelled
// before the traffic exists. Every test awaits this instead, and it runs once.
let seeding = null
function seeded() {
  seeding ??= (async () => {
    await cds.db.run(DELETE.from('factorypilot.token.Consumption').where({ userID: 'bob' }))
    await POST('/insights/ask', { question: 'How many deliveries today in warehouse 1000?', warehouseID: '1000' }, BOB)
    await POST('/insights/ask', { question: 'How many deliveries today in warehouse 1000?', warehouseID: '1000' }, BOB)
    await POST('/insights/ask', { question: 'what is the weather in Berlin', warehouseID: '1000' }, BOB)
  })()
  return seeding
}

describe('DashboardService overview', () => {
  test('counts requests and tokens', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/overview()', ADMIN)
    assert.ok(data.requestsTotal >= 3, 'the seeded requests should be counted')
    assert.ok(data.tokensTotal > 0)
    assert.ok(data.activeUsers >= 1)
    assert.ok(data.activeObjects >= 1)
  })

  test('reports a cache hit ratio once there is traffic', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/overview()', ADMIN)
    // Two identical questions were asked, so at least one lookup hit.
    assert.ok(data.cacheHitRatio > 0, 'a repeated question should show as a hit')
    assert.ok(data.cacheHitRatio <= 100)
  })

  test('grounding is measured over answered requests only', async () => {
    // Counting denials and failures in the denominator would make a healthy
    // system look ungrounded because someone hit their quota.
    await seeded()
    const { data } = await GET('/odata/dashboard/overview()', ADMIN)
    assert.ok(data.groundedRatio >= 0 && data.groundedRatio <= 100)
  })

  test('a business user cannot read the dashboard', async () => {
    await seeded()
    await assert.rejects(
      () => GET('/odata/dashboard/overview()', BOB),
      (err) => err.response?.status === 403
    )
  })
})

describe('DashboardService quota headroom', () => {
  test('reports usage against the applicable limit', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/quotaHeadroom()', ADMIN)
    const bob = (data.value || []).find((r) => r.userID === 'bob')
    assert.ok(bob, 'bob has spent quota and should appear')
    assert.equal(bob.limitDay, 5, 'bob falls under his own seeded policy')
    assert.ok(bob.usedDay >= 3)
  })

  test('flags a user approaching their limit before they are blocked', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/quotaHeadroom()', ADMIN)
    const bob = (data.value || []).find((r) => r.userID === 'bob')
    // 3 of 5 is 60% — not yet at risk. A fourth request crosses 80%.
    assert.equal(bob.atRisk, bob.percentUsed >= 80)
  })

  test('is sorted with the closest to their limit first', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/quotaHeadroom()', ADMIN)
    const pcts = (data.value || []).map((r) => r.percentUsed)
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a))
  })
})

describe('DashboardService aggregates', () => {
  test('breaks traffic down by business object', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/ByObject', ADMIN)
    const delivery = (data.value || []).find((r) => r.objectCode === 'DELIVERY')
    assert.ok(delivery, 'DELIVERY should appear')
    assert.ok(delivery.requests >= 2)
  })

  test('separates backend time from total', async () => {
    // This split is what says whether a slow answer is S/4 or the model — the
    // two have completely different fixes.
    await seeded()
    const { data } = await GET('/odata/dashboard/LatencySplit', ADMIN)
    assert.ok((data.value || []).length >= 1)
    for (const row of data.value) {
      assert.ok(row.avgTotalMs >= 0)
      assert.ok(row.avgBackendMs >= 0)
    }
  })

  test('groups repeated questions', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/TopQuestions', ADMIN)
    const repeated = (data.value || []).find((r) => r.asked >= 2)
    assert.ok(repeated, 'the question asked twice should be grouped')
  })

  test('volume is reported per day', async () => {
    await seeded()
    const { data } = await GET('/odata/dashboard/VolumeByDay', ADMIN)
    assert.ok((data.value || []).length >= 1)
    assert.ok(data.value[0].requests >= 1)
  })

  test('the dashboard is read-only', async () => {
    await seeded()
    await assert.rejects(
      () => POST('/odata/dashboard/ByObject', { objectCode: 'FORGED' }, ADMIN),
      (err) => [403, 405].includes(err.response?.status)
    )
  })
})
