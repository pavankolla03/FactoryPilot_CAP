const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const tools = require('../srv/lib/tools')

/**
 * Date windows for the filter builder.
 *
 * Two things are being protected here.
 *
 * The first is a real bug that was already shipped: the resolved day came from
 * `new Date().toISOString().slice(0, 10)`, which converts to UTC before taking
 * the date. East of Greenwich, every question asked between midnight and the
 * UTC offset resolved "today" to *yesterday* — so a supervisor on an early
 * shift in India got the previous day's figures, and the answer looked
 * perfectly plausible. West of Greenwich the same fault appears late in the
 * evening. Nothing in the output said anything was wrong.
 *
 * The second is the window arithmetic itself, which is the sort of code that
 * looks obviously right and is off by one for a year.
 */

const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Sunday 6 September 2026 — deliberately a Sunday, which is where a
// Sunday-start week and a Monday-start week disagree.
const SUNDAY = new Date(2026, 8, 6, 10, 0, 0)

describe('resolving a preset into a window', () => {
  const range = (p, now = SUNDAY) => {
    const r = tools.dateRange(p, now)
    return [fmt(r.from), fmt(r.to)]
  }

  test('a single day is a window whose ends are equal', () => {
    // This is what keeps every existing filter template working unchanged.
    assert.deepEqual(range('today'), ['2026-09-06', '2026-09-06'])
    assert.deepEqual(range('yesterday'), ['2026-09-05', '2026-09-05'])
    assert.deepEqual(range('tomorrow'), ['2026-09-07', '2026-09-07'])
  })

  test('an unknown preset falls back to today rather than throwing', () => {
    assert.deepEqual(range('sometime'), ['2026-09-06', '2026-09-06'])
    assert.deepEqual(range(undefined), ['2026-09-06', '2026-09-06'])
  })

  test('rolling windows include today and count back inclusively', () => {
    // Seven days means seven, not eight. today-6 through today.
    assert.deepEqual(range('last_7_days'), ['2026-08-31', '2026-09-06'])
    assert.deepEqual(range('last_30_days'), ['2026-08-08', '2026-09-06'])
  })

  test('weeks start on Monday, which is what an operations week means', () => {
    // On a Sunday this is the whole difference: a Sunday-start week would call
    // today the first day of the week and put "last week" a day out.
    assert.deepEqual(range('this_week'), ['2026-08-31', '2026-09-06'])
    assert.deepEqual(range('last_week'), ['2026-08-24', '2026-08-30'])
  })

  test('a Monday is the first day of its own week, not the last of the previous', () => {
    const monday = new Date(2026, 8, 7, 9, 0, 0)
    assert.deepEqual(range('this_week', monday), ['2026-09-07', '2026-09-07'])
    assert.deepEqual(range('last_week', monday), ['2026-08-31', '2026-09-06'])
  })

  test('months run from the first to today, and last month to its real last day', () => {
    assert.deepEqual(range('this_month'), ['2026-09-01', '2026-09-06'])
    assert.deepEqual(range('last_month'), ['2026-08-01', '2026-08-31'])
  })

  test('last month from March lands on February, whatever length it is', () => {
    // 2026 is not a leap year; February has 28 days.
    const march = new Date(2026, 2, 15, 9, 0, 0)
    assert.deepEqual(range('last_month', march), ['2026-02-01', '2026-02-28'])
    const leapMarch = new Date(2028, 2, 15, 9, 0, 0)
    assert.deepEqual(range('last_month', leapMarch), ['2028-02-01', '2028-02-29'])
  })

  test('January looks back into the previous year', () => {
    const jan = new Date(2026, 0, 10, 9, 0, 0)
    assert.deepEqual(range('last_month', jan), ['2025-12-01', '2025-12-31'])
  })
})

describe('the resolved dates are local, not UTC', () => {
  test('an early-morning question resolves to today, not yesterday', () => {
    // The shipped bug. At 00:30 local, east of Greenwich, toISOString() would
    // have produced the previous day — and the answer would have looked fine.
    const justAfterMidnight = new Date(2026, 8, 6, 0, 30, 0)
    const r = tools.dateRange('today', justAfterMidnight)
    assert.equal(fmt(r.to), '2026-09-06',
      'a question asked at 00:30 is about today, whatever UTC thinks')
  })

  test('a late-evening question does not roll forward either', () => {
    const lateEvening = new Date(2026, 8, 6, 23, 45, 0)
    assert.equal(fmt(tools.dateRange('today', lateEvening).to), '2026-09-06')
  })

  test('the filter it produces carries the local date', () => {
    const filter = tools.buildFilter(
      "CreationDate eq {today} and Plant eq '{plant}'",
      { datePreset: 'today', warehouseID: '1710' }, 'v4', {})
    const today = fmt(new Date())
    assert.ok(filter.includes(today), `expected the filter to contain ${today}, got: ${filter}`)
  })
})

describe('filter templates', () => {
  test('a range template gets both ends', () => {
    const filter = tools.buildFilter(
      "PostingDate ge {fromDate} and PostingDate le {toDate}",
      { datePreset: 'last_7_days' }, 'v4', {})
    assert.match(filter, /PostingDate ge \d{4}-\d{2}-\d{2} and PostingDate le \d{4}-\d{2}-\d{2}/)
  })

  test('an existing single-day template is untouched by any of this', () => {
    const filter = tools.buildFilter(
      "CreationDate eq {today}", { datePreset: 'yesterday' }, 'v4', {})
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
    assert.equal(filter, `CreationDate eq ${fmt(yesterday)}`)
  })

  test('OData v2 still gets its datetime literal', () => {
    const filter = tools.buildFilter("CreationDate eq {today}", { datePreset: 'today' }, 'v2', {})
    assert.match(filter, /datetime'\d{4}-\d{2}-\d{2}T00:00:00'/)
  })

  test('a clause whose placeholder has no value is dropped, not left empty', () => {
    // The existing rule, re-asserted because the range work touched this path:
    // an unfiltered question must still work rather than sending `Plant eq ''`.
    const filter = tools.buildFilter(
      "Plant eq '{plant}' and Material eq '{materialID}'", { datePreset: 'today' }, 'v4', {})
    assert.equal(filter, '', 'with neither value known, nothing should be sent')
  })
})
