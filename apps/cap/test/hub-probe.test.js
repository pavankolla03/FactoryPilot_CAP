/**
 * The Hub probe's field comparison.
 *
 * The probe's whole value is answering "do the names we query by actually
 * exist upstream?" — and that comparison is the one part that never runs in CI,
 * because it needs a live SAP_HUB_API_KEY. So it is tested here directly
 * against payload shapes the Hub really returns.
 *
 * A wrong field name does not fail loudly against OData: $select of a column
 * that does not exist errors, but a $filter on one silently matches nothing,
 * and the user is told "no records" for data that is sitting right there.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { checkFields, rowsOf } = require('../../../scripts/hub-probe.js')

describe('hub probe — payload shapes', () => {
  test('finds rows in v2, v4 and neither', () => {
    assert.deepEqual(rowsOf({ d: { results: [{ a: 1 }] } }), [{ a: 1 }])
    assert.deepEqual(rowsOf({ d: [{ a: 1 }] }), [{ a: 1 }])
    assert.deepEqual(rowsOf({ value: [{ a: 1 }] }), [{ a: 1 }])
    assert.deepEqual(rowsOf({ nothing: true }), [])
    assert.deepEqual(rowsOf(null), [])
  })
})

describe('hub probe — field comparison', () => {
  // The shape A_MatlStkInAcctMod really returns, __metadata included.
  const ACTUAL = [
    '__metadata',
    'Material',
    'Plant',
    'StorageLocation',
    'MaterialBaseUnit',
    'MatlWrhsStkQtyInMatlBaseUnit',
  ]

  test('accepts a configuration whose fields all exist', () => {
    const out = checkFields(
      {
        selectFields: 'Material,Plant,MaterialBaseUnit',
        defaultFilters: "Plant eq '{plant}' and Material eq '{materialID}'",
      },
      ACTUAL
    )
    assert.deepEqual(out.missingSelect, [])
    assert.deepEqual(out.missingFilter, [])
  })

  test('names a select field that does not exist upstream', () => {
    const out = checkFields({ selectFields: 'Material,QuantityOnHand', defaultFilters: '' }, ACTUAL)
    assert.deepEqual(out.missingSelect, ['QuantityOnHand'])
  })

  test('names a filter field that does not exist — the silent failure', () => {
    // This is the dangerous one. OData accepts the request and returns zero
    // rows, so the product reports "no records matched" rather than an error.
    const out = checkFields({ selectFields: '', defaultFilters: "Werks eq '1000'" }, ACTUAL)
    assert.deepEqual(out.missingFilter, ['Werks'])
  })

  test('reads every field out of a multi-clause filter template', () => {
    const out = checkFields(
      { selectFields: '', defaultFilters: "PostingDate eq {today} and Plant eq '{plant}' and Material eq '{materialID}'" },
      ACTUAL
    )
    // PostingDate is absent from this entity set; the other two are present.
    assert.deepEqual(out.missingFilter, ['PostingDate'])
  })

  test('suggests real field names, and never suggests __metadata', () => {
    const out = checkFields({ selectFields: 'Material', defaultFilters: '' }, ACTUAL)
    assert.ok(out.unusedButPresent.includes('Plant'))
    assert.ok(!out.unusedButPresent.includes('__metadata'), 'OData plumbing is not a business field')
    assert.ok(!out.unusedButPresent.includes('Material'), 'already selected')
  })

  test('an unconfigured object reports nothing missing rather than everything', () => {
    const out = checkFields({ selectFields: '', defaultFilters: '' }, ACTUAL)
    assert.deepEqual(out.missingSelect, [])
    assert.deepEqual(out.missingFilter, [])
  })
})
