const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
cds.test(PROJECT).in(PROJECT)

const simulate = require('../srv/lib/simulate')
const tools = require('../srv/lib/tools')

/**
 * What-if projection.
 *
 * Every other answer this product gives is either grounded in rows from SAP or
 * explicitly refused. A projection is neither — it is arithmetic on real
 * numbers — and the danger is that it *reads* exactly like a reading: a
 * confident figure, in a table, from the same assistant that has been quoting
 * real stock all morning.
 *
 * So these tests are mostly about the labelling and the boundaries, not the
 * arithmetic. The arithmetic is a subtraction; the risk is everything around it.
 */

describe('the tool is governed as neither a read nor a write', () => {
  test('it is classified as a simulation', () => {
    assert.equal(tools.isSimulationTool('simulate_stock_change'), true)
  })

  test('it is NOT a write — it must never reach the approval queue', () => {
    // A question somebody could approve by accident is a trap. "What if" is a
    // question; move_stock is the action, and they must stay separate.
    assert.equal(tools.isWriteTool('simulate_stock_change'), false)
  })

  test('a real read is not mistaken for a simulation', () => {
    assert.equal(tools.isSimulationTool('query_material_stock'), false)
  })

  test('the model is told the result is not a figure from SAP', async () => {
    const { BusinessObjectConfig } = cds.entities('factorypilot.config')
    const bos = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
    const def = tools.buildDefinitions(bos).find((d) => d.function.name === 'simulate_stock_change')
    assert.ok(def, 'the simulation tool should be offered')
    assert.match(def.function.description, /NOT a figure from SAP/)
    assert.match(def.function.description, /changes nothing and proposes nothing/)
  })

  test('the sign convention is spelled out, because it is the easy mistake', () => {
    const bos = [{ objectCode: 'MATERIAL_STOCK', objectName: 'Material Stock' }]
    const def = tools.buildDefinitions(bos).find((d) => d.function.name === 'simulate_stock_change')
    assert.match(def.function.parameters.properties.quantity.description, /Negative to remove/)
  })
})

describe('the arithmetic, with no live read', () => {
  /**
   * Fixed rows rather than a live query. The first version of this test could
   * only run where SAP credentials happened to exist, so the projection logic
   * was covered by accident of environment — the same fault that made an
   * earlier watcher test pass alone and fail in the suite.
   */
  const rows = [
    { Material: 'P123', MatlWrhsStkQtyInMatlBaseUnit: 400 },
    { Material: 'P123', MatlWrhsStkQtyInMatlBaseUnit: 200 },
    { Material: 'P999', MatlWrhsStkQtyInMatlBaseUnit: 50 },
  ]

  test('every result is marked as a projection', () => {
    // The flag travels inside the result so the model cannot report the number
    // without the caveat attached to it.
    assert.equal(watch(rows, -100).projection, true)
  })

  const watch = (r, d) => simulate.project(r, d)

  test('quantities are summed per material before the change is applied', () => {
    const r = watch(rows, -100)
    const p123 = r.lines.find((l) => l.material === 'P123')
    assert.equal(p123.current, 600, 'two rows of the same material are one position')
    assert.equal(p123.projected, 500)
  })

  test('removing more than exists is reported as a shortfall, not clamped to zero', () => {
    const r = watch(rows, -700)
    const p123 = r.lines.find((l) => l.material === 'P123')
    assert.equal(p123.projected, -100)
    assert.equal(p123.goesNegative, true)
    assert.equal(p123.shortfall, 100)
    assert.equal(r.shortfalls, 2, 'both materials fall below zero at -700')
    assert.match(r.message, /2 materials would go negative/)
  })

  test('adding stock is the same operation with the opposite sign', () => {
    const r = watch(rows, 1000)
    assert.equal(r.shortfalls, 0, 'adding stock cannot create a shortfall')
    for (const l of r.lines) assert.ok(l.projected > l.current)
    assert.match(r.message, /Nothing would go negative/)
  })

  test('the caveat names what it does not model', () => {
    // Without this it reads as an availability check. It is not one — it sees
    // no reservations, no safety stock, no open orders and no lead times.
    const r = watch(rows, -100)
    assert.match(r.message, /Projection only/)
    assert.match(r.message, /not a figure from SAP/)
    assert.match(r.message, /reservations, safety stock, open orders or lead times/)
  })

  test('the field the arithmetic used is named', () => {
    assert.equal(watch(rows, -1).basis.quantityField, 'MatlWrhsStkQtyInMatlBaseUnit')
  })

  test('an unrecognisable quantity field yields no projection at all', () => {
    // Better to refuse than to invent a basis. A confident number computed
    // from a field it did not understand is the worst possible output here.
    const r = simulate.project([{ Material: 'P1', SomeOtherColumn: 5 }], -1)
    assert.equal(r.basis, null)
    assert.equal(r.lines, undefined)
    assert.match(r.message, /no projection can be made/)
  })

  test('non-numeric quantities are skipped rather than read as zero', () => {
    const r = simulate.project([
      { Material: 'P1', Quantity: 10 },
      { Material: 'P1', Quantity: 'n/a' },
    ], -5)
    assert.equal(r.lines[0].current, 10, 'the unusable row should not drag the total down')
  })
})

describe('reading before projecting', () => {
  const context = async () => {
    const { BusinessObjectConfig } = cds.entities('factorypilot.config')
    return {
      businessObjects: await SELECT.from(BusinessObjectConfig).where({ isActive: true }),
      defaults: { warehouse: '1000' },
      correlationId: 'test-sim',
    }
  }

  test('a quantity is required — there is nothing to project without one', async () => {
    const ctx = await context()
    await assert.rejects(
      () => simulate.stockChange({ ...ctx, quantity: undefined }),
      /quantity is required/)
  })

  test('an unregistered stock object is refused with a reason', async () => {
    await assert.rejects(
      () => simulate.stockChange({
        businessObjects: [], defaults: {}, correlationId: 'x', quantity: -1 }),
      /MATERIAL_STOCK is not registered/)
  })
})

/**
 * The direction of a change, which is where this feature can be most wrong.
 *
 * A what-if with the sign backwards does not fail — it answers the opposite
 * question confidently. "Would anything run short if I move 500 out?" answered
 * from +500 says "nothing would go negative", which is exactly the reassurance
 * that should not have been given. Found by end-to-end testing, not by unit
 * tests: the arithmetic was right and the argument reaching it was not.
 */
describe('reading the direction of a change', () => {
  const llm = require('../srv/lib/llm')

  const TOOLS = [{
    type: 'function',
    function: {
      name: 'simulate_stock_change',
      description: 'Project a hypothetical change.\nkeywords: what if, simulate, move',
      parameters: { type: 'object', properties: { quantity: { type: 'number' }, materialID: { type: 'string' } } },
    },
  }]

  const quantityFor = async (question) => {
    const provider = new llm.FakeProvider('offline')
    const r = await provider.complete({
      messages: [{ role: 'user', content: question }],
      tools: TOOLS,
    })
    return r.toolCalls?.[0]?.arguments?.quantity
  }

  test('moving stock OUT is a negative change', async () => {
    assert.equal(await quantityFor('what if I move 500 units of P123 out of plant 1000'), -500)
  })

  test('removing is negative however it is phrased', async () => {
    assert.equal(await quantityFor('what if we remove 250 units of P123'), -250)
    assert.equal(await quantityFor('simulate issuing 100 units of P123'), -100)
  })

  test('adding stock is a positive change', async () => {
    assert.equal(await quantityFor('what if we receive 300 units of P123 into plant 1000'), 300)
  })

  test('an ambiguous sentence keeps the stated sign rather than guessing', async () => {
    // The rendered projection states the direction, so a wrong assumption is
    // visible. Silently inverting an unclear sentence would not be.
    const q = await quantityFor('what if 400 units of P123')
    assert.ok(q === 400 || q === undefined, `expected the stated value or nothing, got ${q}`)
  })
})

describe('how a projection reaches the reader', () => {
  const llm = require('../srv/lib/llm')

  test('a projection is never rendered as an empty reading', async () => {
    // The bug end-to-end testing found: a projection has neither `error` nor
    // `rows`, so it fell through to the empty-rows branch and came back as
    // "No records matched that question." — a projection presented as an
    // absence of data, which is the precise conflation this feature exists to
    // avoid. Unit tests missed it because they exercised the projection
    // function directly rather than the answer a person sees.
    const provider = new llm.FakeProvider('offline')
    const projection = {
      projection: true,
      basis: { quantityField: 'Quantity' },
      change: -500,
      lines: [{ material: 'P123', current: 668, change: -500, projected: 168, goesNegative: false, shortfall: 0 }],
      shortfalls: 0,
      message: 'Projection only — arithmetic on the current reading, not a figure from SAP.',
    }
    const r = await provider.complete({
      messages: [
        { role: 'user', content: 'what if I move 500 out of P123' },
        { role: 'tool', name: 'simulate_stock_change', content: JSON.stringify(projection) },
      ],
      tools: [],
    })
    assert.doesNotMatch(r.text, /No records matched/,
      'a projection must never read as an absence of data')
    assert.match(r.text, /not a figure from SAP/, 'the caveat must lead')
    assert.match(r.text, /P123/, 'and the figures must be there')
  })

  test('a projection with nothing to project from says so', async () => {
    const provider = new llm.FakeProvider('offline')
    const r = await provider.complete({
      messages: [
        { role: 'user', content: 'what if I move 500 out of NOPE' },
        { role: 'tool', name: 'simulate_stock_change', content: JSON.stringify({
          projection: true, basis: null,
          message: 'No current stock matched that material and plant, so there is nothing to project from.',
        }) },
      ],
      tools: [],
    })
    assert.match(r.text, /nothing to project from/)
    assert.doesNotMatch(r.text, /No records matched that question/)
  })
})
