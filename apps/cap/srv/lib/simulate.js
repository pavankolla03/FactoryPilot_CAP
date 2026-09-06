/**
 * What-if projection. (BETA)
 *
 * "If I move 500 units out of 1710, what runs short?" — decision support
 * rather than lookup, and the first thing this product says that is not a fact.
 *
 * That is the whole design problem. Every other answer here is either grounded
 * in rows that came back from SAP or explicitly refused; a projection is
 * neither. It is arithmetic performed on real numbers, and the danger is that
 * it *reads* exactly like a reading — a confident figure, in a table, from the
 * same assistant that has been quoting real stock all morning.
 *
 * So three rules, enforced structurally rather than by asking the model nicely:
 *
 * 1. **Inputs are grounded; the output is not.** A simulation reads real stock,
 *    so its inputs are as trustworthy as any other answer. The projected figure
 *    is not, and must never set the `grounded` flag on its own. The agent
 *    treats this as a third kind of tool for exactly this reason.
 *
 * 2. **The result carries its own label.** `projection: true` and a `basis`
 *    naming the reading it was computed from travel *inside* the tool result,
 *    so the model cannot present the number without the caveat attached to it.
 *
 * 3. **It never writes.** A simulation is not a proposed action. Asking "what
 *    if" must not produce something a person can approve by accident — that is
 *    what `move_stock` and the approval gate are for.
 */

const cds = require('@sap/cds')
const tools = require('./tools')

const log = cds.log('simulate')

const READ_TIMEOUT_MS = Number(process.env.FACTORYPILOT_SIMULATE_READ_MS || 20_000)

/** Fields a stock row might carry its quantity in, most specific first. */
const QUANTITY_FIELDS = [
  'MatlWrhsStkQtyInMatlBaseUnit',
  'QuantityInBaseUnit',
  'Quantity',
  'StockQuantity',
]

/** Fields that identify the material, for grouping the projection. */
const MATERIAL_FIELDS = ['Material', 'MaterialNumber', 'Product']

function pick(row, candidates) {
  for (const f of candidates) if (row[f] !== undefined && row[f] !== null) return { field: f, value: row[f] }
  return null
}

/**
 * Project the effect of a quantity change on current stock.
 *
 * Deliberately arithmetic and nothing more. A real availability check would
 * have to consider reservations, safety stock, open orders and lead times —
 * none of which this reads — so pretending to model them would be the same
 * mistake as presenting the projection as a fact. What it *can* say honestly
 * is "this reading, minus that amount, leaves this", and it says exactly that.
 */
async function stockChange({ materialID, warehouseID, quantity, businessObjects, defaults, correlationId }) {
  if (!Number.isFinite(Number(quantity))) throw new Error('a quantity is required to project a change')
  const delta = Number(quantity)

  const bo = businessObjects.find((b) => b.objectCode === 'MATERIAL_STOCK')
  if (!bo) throw new Error('MATERIAL_STOCK is not registered, so current stock cannot be read')

  const args = {}
  if (materialID) args.materialID = materialID
  if (warehouseID) args.warehouseID = warehouseID

  const result = await tools.executeRead(
    tools.toolNameFor('MATERIAL_STOCK'), args,
    { businessObjects, defaults, correlationId, timeoutMs: READ_TIMEOUT_MS })

  const rows = result.rows || []
  if (!rows.length) {
    // No basis means no projection. Returning "0 − 500 = −500" would be a
    // confident answer built on nothing, which is the exact failure this
    // module exists to avoid.
    return {
      projection: true,
      basis: null,
      queriedWith: result.queriedWith,
      message: 'No current stock matched that material and plant, so there is nothing to project from. ' +
        'Check the material number and plant before reading anything into this.',
    }
  }

  const projected = project(rows, delta)
  if (!projected.lines) return projected
  return {
    ...projected,
    basis: {
      source: 'MATERIAL_STOCK',
      rowsRead: result.rowCount ?? rows.length,
      quantityField: projected.basis.quantityField,
      queriedWith: result.queriedWith,
    },
  }
}

/**
 * The arithmetic, with no I/O.
 *
 * Separated so it can be tested exhaustively without a live SAP read. The
 * earlier version could only be exercised where credentials happened to exist,
 * which meant the projection logic was covered by accident of environment —
 * the same fault that made an earlier watcher test pass alone and fail in the
 * suite.
 */
function project(rows, delta) {
  const qField = pick(rows[0], QUANTITY_FIELDS)
  if (!qField) {
    return {
      projection: true,
      basis: null,
      message: `Stock rows came back but none carried a recognisable quantity field ` +
        `(looked for ${QUANTITY_FIELDS.join(', ')}), so no projection can be made.`,
    }
  }

  const mField = pick(rows[0], MATERIAL_FIELDS)
  const byMaterial = new Map()
  for (const r of rows) {
    const key = mField ? String(r[mField.field] ?? '(unknown)') : '(all)'
    const value = Number(r[qField.field])
    if (!Number.isFinite(value)) continue
    byMaterial.set(key, (byMaterial.get(key) || 0) + value)
  }

  const lines = [...byMaterial.entries()].map(([material, current]) => {
    const after = current + delta
    return {
      material,
      current,
      change: delta,
      projected: after,
      goesNegative: after < 0,
      shortfall: after < 0 ? Math.abs(after) : 0,
    }
  })

  const short = lines.filter((l) => l.goesNegative)

  return {
    projection: true,
    basis: { quantityField: qField.field },
    change: delta,
    lines,
    shortfalls: short.length,
    message:
      `Projection only — arithmetic on the current reading, not a figure from SAP. ` +
      `It does not consider reservations, safety stock, open orders or lead times.` +
      (short.length
        ? ` ${short.length} material${short.length === 1 ? '' : 's'} would go negative.`
        : ' Nothing would go negative on this reading alone.'),
  }
}

module.exports = { stockChange, project, QUANTITY_FIELDS, MATERIAL_FIELDS }
