const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const anomaly = require('../srv/lib/anomaly')

/**
 * Anomaly detection over reads.
 *
 * The judgement is pure and most of the risk lives there, so that is where the
 * tests concentrate. Each one corresponds to a way this kind of feature
 * usually fails in the field: it cries wolf before it knows anything, one bad
 * day teaches it that bad days are normal, or it only ever notices spikes and
 * misses the collapse that actually costs money.
 */

afterEach(async () => {
  const { Observation } = cds.entities('factorypilot.jobs')
  await DELETE.from(Observation).where({ objectCode: 'TEST_OBJECT' })
})

describe('the median, and why it is not the mean', () => {
  test('it is the middle value', () => {
    assert.equal(anomaly.median([5, 1, 3]), 3)
    assert.equal(anomaly.median([4, 1, 3, 2]), 2.5)
    assert.equal(anomaly.median([]), null)
  })

  test('one freak day does not move it', () => {
    // The whole reason for a median. With a mean, the 5000 below drags the
    // baseline to ~840 and the next genuinely bad day reads as normal — the
    // metric stops working immediately after the event it should have learnt
    // from.
    const normal = [10, 11, 9, 10, 12]
    const withSpike = [...normal, 5000]
    assert.equal(anomaly.median(normal), 10)
    assert.equal(anomaly.median(withSpike), 10.5)
    const mean = withSpike.reduce((a, b) => a + b, 0) / withSpike.length
    assert.ok(mean > 800, 'a mean would have been dragged to nearly a thousand')
  })
})

describe('judging a value against its history', () => {
  const history = [10, 11, 9, 10, 12, 10]     // median 10

  test('it stays silent until it has seen enough', () => {
    // Alerting from a standing start trains the recipient to ignore this
    // within a week, and an ignored alert is worse than none.
    const verdict = anomaly.judge(1000, [10, 11], 5)
    assert.equal(verdict.anomalous, false)
    assert.match(verdict.reason, /only 2 observations/)
  })

  test('a spike is flagged', () => {
    const v = anomaly.judge(60, history, 5)
    assert.equal(v.anomalous, true)
    assert.match(v.reason, /6\.0× the usual 10/)
  })

  test('a collapse is flagged too — the case the write-side detector misses', () => {
    // policy.detectAnomaly only ever looks upward, because for a write the
    // dangerous direction is 50× too much. For a read, stock falling to a
    // fraction of normal is at least as worth knowing.
    const v = anomaly.judge(1, history, 5)
    assert.equal(v.anomalous, true)
    assert.match(v.reason, /well below the usual 10/)
  })

  test('ordinary variation is not flagged', () => {
    assert.equal(anomaly.judge(13, history, 5).anomalous, false)
    assert.equal(anomaly.judge(7, history, 5).anomalous, false)
  })

  test('the factor decides how surprised it gets', () => {
    assert.equal(anomaly.judge(30, history, 5).anomalous, false)  // 3× — under a factor of 5
    assert.equal(anomaly.judge(30, history, 2).anomalous, true)   // 3× — over a factor of 2
  })

  test('a series that has always been zero does not divide by it', () => {
    const zeros = [0, 0, 0, 0, 0, 0]
    const v = anomaly.judge(7, zeros, 5)
    assert.equal(v.anomalous, true)
    assert.match(v.reason, /where this has always been 0/)
    assert.equal(anomaly.judge(0, zeros, 5).anomalous, false, 'still zero is not news')
  })
})

describe('sweeping', () => {
  test('it observes the registered objects and reports what it found', async () => {
    const result = await anomaly.sweep()
    assert.ok(typeof result.observed === 'number')
    assert.ok(Array.isArray(result.findings))
    assert.ok(Array.isArray(result.errors))
    // Every object is either observed or explained; none may vanish silently.
    const { BusinessObjectConfig } = cds.entities('factorypilot.config')
    const active = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
    assert.equal(result.observed + result.errors.length, active.length)
  })

  test('an early sweep records history without crying wolf', async () => {
    // First observations have nothing to compare against, so however odd the
    // numbers look, nothing should be flagged.
    const { Observation } = cds.entities('factorypilot.jobs')
    await DELETE.from(Observation)
    const result = await anomaly.sweep()
    assert.equal(result.findings.length, 0,
      'with no history there is no such thing as unusual')
    const stored = await SELECT.from(Observation)
    assert.ok(stored.length >= result.observed, 'observations should still be recorded')
  })

  test('a failed read is not stored as an observation', async () => {
    // Storing it as zero would poison the median and make the next real
    // reading look like a spike.
    const result = await anomaly.sweep()
    const { Observation } = cds.entities('factorypilot.jobs')
    const stored = await SELECT.from(Observation).where({ observedAt: { '>': new Date(Date.now() - 60_000) } })
    for (const e of result.errors) {
      assert.ok(!stored.some((o) => o.objectCode === e.objectCode && o.rowCount === 0),
        `${e.objectCode} failed to read and must not appear as a zero observation`)
    }
  })
})

describe('the message', () => {
  test('nothing unusual says so plainly', () => {
    const text = anomaly.render({ observed: 5, findings: [], errors: [] })
    assert.match(text, /Nothing unusual/)
    assert.match(text, /\[BETA\]/)
  })

  test('a finding names the object, the place and the reason', () => {
    const text = anomaly.render({
      observed: 5,
      findings: [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock', warehouseID: '1710',
        value: 3, reason: '3 is well below the usual 120.' }],
      errors: [],
    })
    assert.match(text, /Material Stock \(plant 1710\)/)
    assert.match(text, /well below the usual 120/)
  })

  test('unreadable objects are separated from healthy ones', () => {
    const text = anomaly.render({
      observed: 2, findings: [],
      errors: [{ objectCode: 'PURCHASING', error: 'Graph returned HTTP 401' }],
    })
    assert.match(text, /could not be read/)
    assert.match(text, /not an observation/)
  })
})
