const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const watchers = require('../srv/lib/watchers')

/**
 * Watchers, and mostly the edge.
 *
 * A watcher is swept on a schedule, so a breached condition is breached again
 * at the next sweep and the one after. Alerting every time produces a message
 * every fifteen minutes about a situation the recipient already knows about —
 * which gets muted, and a muted alert is worse than no alert because everyone
 * still believes it works. Almost everything below is about firing once.
 */

const NAME = 'test-watcher'

async function seed(fields = {}) {
  const { Watcher } = cds.entities('factorypilot.jobs')
  await DELETE.from(Watcher).where({ name: NAME })
  await INSERT.into(Watcher).entries({
    name: NAME,
    objectCode: 'MATERIAL_STOCK',
    measure: 'ROW_COUNT',
    comparison: 'LT',
    threshold: 10,
    isActive: true,
    lastBreached: false,
    ...fields,
  })
  return SELECT.one.from(cds.entities('factorypilot.jobs').Watcher).where({ name: NAME })
}

afterEach(async () => {
  const { Watcher } = cds.entities('factorypilot.jobs')
  await DELETE.from(Watcher).where({ name: NAME })
})

describe('reducing rows to the number being watched', () => {
  const rows = [{ qty: 5 }, { qty: 12 }, { qty: 3 }]

  test('row count needs no field name — the part people get wrong', () => {
    assert.equal(watchers.measure({ measure: 'ROW_COUNT' }, rows), 3)
    assert.equal(watchers.measure({}, rows), 3)
  })

  test('min, max and sum read the named field', () => {
    assert.equal(watchers.measure({ measure: 'FIELD_MIN', fieldName: 'qty' }, rows), 3)
    assert.equal(watchers.measure({ measure: 'FIELD_MAX', fieldName: 'qty' }, rows), 12)
    assert.equal(watchers.measure({ measure: 'FIELD_SUM', fieldName: 'qty' }, rows), 20)
  })

  test('a misspelt field is an error, not a zero', () => {
    // Zero would read as "stock is zero" and fire a below-threshold alert for
    // what is actually a typo in the configuration.
    assert.throws(
      () => watchers.measure({ measure: 'FIELD_MIN', fieldName: 'quantiy' }, rows),
      /no numeric values found/)
  })

  test('a field measure without a field name is refused', () => {
    assert.throws(() => watchers.measure({ measure: 'FIELD_SUM' }, rows), /needs a field name/)
  })
})

describe('comparisons', () => {
  test('each operator means what it says', () => {
    const { LT, LTE, GT, GTE, EQ, NE } = watchers.COMPARISONS
    assert.equal(LT(4, 5), true);   assert.equal(LT(5, 5), false)
    assert.equal(LTE(5, 5), true);  assert.equal(GT(6, 5), true)
    assert.equal(GTE(5, 5), true);  assert.equal(EQ(5, 5), true)
    assert.equal(NE(4, 5), true)
  })
})

describe('the alert text', () => {
  test('says the number, the rule and the place', () => {
    const text = watchers.describe(
      { name: 'Low stock 1710', measure: 'FIELD_MIN', fieldName: 'Quantity',
        comparison: 'LT', threshold: 500, warehouseID: '1710' }, 320)
    assert.match(text, /Low stock 1710/)
    assert.match(text, /320/)
    assert.match(text, /below 500/)
    assert.match(text, /plant 1710/)
  })

  test('a row-count watcher reads naturally', () => {
    const text = watchers.describe(
      { name: 'Open counts', measure: 'ROW_COUNT', comparison: 'GT', threshold: 0 }, 4)
    assert.match(text, /4 rows/)
    assert.match(text, /above 0/)
  })
})

describe('firing on the edge, not on the state', () => {
  /**
   * An unregistered business object fails deterministically in every
   * environment. Relying on missing SAP credentials instead made this test
   * pass alone and fail in the suite, because `npm test` runs in demo mode
   * where the read succeeds — the test was asserting on the environment.
   */
  const UNREADABLE = { objectCode: 'NO_SUCH_OBJECT' }

  test('a watcher that cannot be read is recorded, never silently cleared', async () => {
    const { Watcher } = cds.entities('factorypilot.jobs')
    await seed({ ...UNREADABLE, lastBreached: true })   // it was breached before

    const result = await watchers.sweep()
    const after = await SELECT.one.from(Watcher).where({ name: NAME })

    assert.equal(result.errors.length, 1, 'an unreadable watcher should be reported')
    assert.equal(after.lastBreached, true,
      'losing the source system must not clear a real alert — that is when it matters most')
    assert.ok(after.lastError, 'the reason should be kept on the row')
  })

  test('an unreadable watcher does not count as an alert', async () => {
    await seed({ ...UNREADABLE, lastBreached: false })
    const result = await watchers.sweep()
    assert.equal(result.alerts.length, 0, 'a failure to read is not a breach')
  })

  /**
   * The behaviour the whole feature turns on, tested against a real read.
   *
   * `GT -1` on a row count is always true, so the first sweep breaches. The
   * second sweep breaches identically — and must stay silent. That silence is
   * the feature.
   */
  test('a breach alerts once, and the unchanged state that follows is silent', async () => {
    const { Watcher } = cds.entities('factorypilot.jobs')
    await seed({ measure: 'ROW_COUNT', comparison: 'GT', threshold: -1, lastBreached: false })

    const first = await watchers.sweep()
    assert.equal(first.errors.length, 0, 'this watcher should be readable in demo mode')
    assert.equal(first.alerts.length, 1, 'crossing into breach should alert')

    const second = await watchers.sweep()
    assert.equal(second.alerts.length, 0,
      'a condition that is still breached must not alert again — this is what stops alerts being muted')

    const after = await SELECT.one.from(Watcher).where({ name: NAME })
    assert.equal(after.alertCount, 1, 'the alert should have been counted exactly once')
  })

  test('a condition that clears reports once, and can alert again later', async () => {
    const { Watcher } = cds.entities('factorypilot.jobs')
    await seed({ measure: 'ROW_COUNT', comparison: 'GT', threshold: -1, lastBreached: false })

    await watchers.sweep()                                    // breaches
    // Move the goalposts so the same data is no longer a breach.
    await UPDATE(Watcher).set({ comparison: 'LT', threshold: -1 }).where({ name: NAME })
    const cleared = await watchers.sweep()
    assert.equal(cleared.cleared.length, 1, 'recovering should be reported once')

    const quiet = await watchers.sweep()
    assert.equal(quiet.cleared.length, 0, 'staying recovered should be silent')
  })

  test('the rendered message distinguishes unreadable from healthy', () => {
    const text = watchers.render({
      checked: 2, alerts: [], cleared: [],
      errors: [{ name: 'Low stock', error: 'Graph returned HTTP 401' }],
    })
    assert.match(text, /could not be checked/)
    assert.match(text, /not the same as one that is fine/)
  })

  test('a newly breached watcher renders as a warning, a recovered one as cleared', () => {
    const text = watchers.render({
      checked: 2,
      alerts: [{ name: 'Low stock', value: 12, text: 'Low stock: 12 rows — below 100.' }],
      cleared: [{ name: 'Overdue POs', value: 0, text: 'Overdue POs: back to normal (0).' }],
      errors: [],
    })
    assert.match(text, /⚠ {2}Low stock/)
    assert.match(text, /✓ {2}Overdue POs/)
    assert.match(text, /\[BETA\]/)
  })

  test('no watchers configured is a clean no-op', async () => {
    const { Watcher } = cds.entities('factorypilot.jobs')
    const saved = await SELECT.from(Watcher)
    await DELETE.from(Watcher)
    const result = await watchers.sweep()
    assert.equal(result.checked, 0)
    assert.equal(result.alerts.length, 0)
    if (saved.length) await INSERT.into(Watcher).entries(saved)
  })

  test('an inactive watcher is not swept', async () => {
    await seed({ isActive: false })
    const result = await watchers.sweep()
    assert.equal(result.checked, 0, 'a disabled watcher should be skipped entirely')
  })
})
