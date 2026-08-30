const cds = require('@sap/cds')
const backend = require('./backend')

/**
 * The agent's tool surface, generated from the registry.
 *
 * Every active BusinessObjectConfig with `exposedAsTool` becomes one read tool.
 * That is the whole point of the registry: onboarding a new module gives the
 * agent a new capability without touching this file.
 */

const WRITE_TOOLS = new Set(['move_stock'])

function toolNameFor(objectCode) {
  return `query_${String(objectCode).toLowerCase()}`
}

/** Fill {today}/{warehouse} style placeholders; drop a clause whose value is
 *  unknown rather than emitting `eq ''`, which returns zero rows and reads as
 *  a genuine empty result. */
function buildFilter(template, args, apiVersion, defaults = {}) {
  if (!template) return ''
  const preset = String(args.datePreset || 'today').toLowerCase()
  const day = new Date()
  if (preset === 'yesterday') day.setDate(day.getDate() - 1)
  if (preset === 'tomorrow') day.setDate(day.getDate() + 1)
  const isoDay = day.toISOString().slice(0, 10)

  const values = {
    today: apiVersion === 'v2' ? `datetime'${isoDay}T00:00:00'` : isoDay,
    date: apiVersion === 'v2' ? `datetime'${isoDay}T00:00:00'` : isoDay,
    warehouse: args.warehouseID || defaults.warehouse || '',
    plant: args.plant || args.warehouseID || defaults.warehouse || '',
  }
  for (const [k, v] of Object.entries(args)) {
    if (values[k] == null && (typeof v === 'string' || typeof v === 'number')) values[k] = String(v)
  }

  return template
    .split(/\s+and\s+/i)
    .filter((clause) => {
      const names = [...clause.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      return names.every((n) => values[n] !== undefined && values[n] !== '')
    })
    .map((clause) => clause.replace(/\{(\w+)\}/g, (_, n) => values[n] ?? ''))
    .join(' and ')
    .trim()
}

/**
 * Template an OData $expand the same way a filter is templated.
 *
 * The interesting part is the nested `$filter`: SAP Graph exposes material
 * document *headers*, and the plant lives on the items, so the only way to ask
 * "movements in plant 1710" is a filter inside the expand. Routing it through
 * buildFilter means an unresolvable placeholder drops its clause rather than
 * being sent as `Plant eq ''`, which would return nothing and read as "there
 * were no movements".
 */
function buildExpand(template, args, apiVersion, defaults = {}) {
  if (!template) return ''
  const open = template.indexOf('(')
  if (open === -1) return template.trim()
  const nav = template.slice(0, open).trim()
  const inner = template.slice(open + 1, template.lastIndexOf(')'))

  const options = inner
    .split(';')
    .map((opt) => {
      const trimmed = opt.trim()
      if (!/^\$filter=/i.test(trimmed)) return trimmed
      const built = buildFilter(trimmed.slice(trimmed.indexOf('=') + 1), args, apiVersion, defaults)
      return built ? `$filter=${built}` : ''
    })
    .filter(Boolean)

  return options.length ? `${nav}(${options.join(';')})` : nav
}

/** OpenAI-style tool definitions the provider can call. */
function buildDefinitions(businessObjects) {
  const defs = businessObjects.map((bo) => ({
    type: 'function',
    function: {
      name: toolNameFor(bo.objectCode),
      description:
        `Query ${bo.objectName || bo.objectCode} records from SAP S/4HANA. ` +
        `${bo.promptHints || ''}\nkeywords: ${bo.keywords || ''}`,
      parameters: {
        type: 'object',
        properties: {
          warehouseID: { type: 'string', description: 'Shipping point / plant, e.g. 1000' },
          datePreset: { type: 'string', enum: ['today', 'yesterday', 'tomorrow'], description: 'Which day to report on' },
          // Without this the model has nowhere to put a material the user
          // named, so "how much stock of P123" silently reported every
          // material. Clauses referencing it are dropped when it is absent, so
          // the unfiltered question still works.
          materialID: { type: 'string', description: 'Material number, when the question names one, e.g. P123' },
        },
        required: [],
      },
    },
  }))

  // The one write tool. Declared separately because it is governed differently:
  // it never executes inline, only through confirmAction.
  defs.push({
    type: 'function',
    function: {
      name: 'move_stock',
      description:
        'Move stock between storage locations. This is a WRITE and requires human confirmation.\n' +
        'keywords: move, move stock, transfer, relocate, move material, post goods movement',
      parameters: {
        type: 'object',
        properties: {
          materialID: { type: 'string' },
          warehouseID: { type: 'string' },
          fromLocation: { type: 'string' },
          toLocation: { type: 'string' },
          quantity: { type: 'number' },
        },
        required: ['materialID', 'warehouseID', 'quantity'],
      },
    },
  })

  return defs
}

function isWriteTool(name) {
  return WRITE_TOOLS.has(name)
}

/**
 * Run a read tool. Write tools never reach here from the loop — they are
 * diverted into a PendingAction first.
 */
async function executeRead(toolName, args, { businessObjects, defaults, correlationId, timeoutMs }) {
  const bo = businessObjects.find((b) => toolNameFor(b.objectCode) === toolName)
  if (!bo) throw new backend.BackendError(`Unknown tool: ${toolName}`, 400)

  const { IntegrationEndpoint } = cds.entities('factorypilot.integration')
  const endpoint = bo.endpoint_ID
    ? await SELECT.one.from(IntegrationEndpoint).where({ ID: bo.endpoint_ID })
    : null

  const client = backend.forEndpoint(endpoint)
  // The agent may have less time left than the endpoint's configured timeout.
  // Honour whichever is shorter so one slow tool cannot outlast the request.
  if (timeoutMs && timeoutMs < client.timeoutMs) client.timeoutMs = timeoutMs
  const filter = buildFilter(bo.defaultFilters, args, bo.apiVersion, defaults)
  const expand = buildExpand(bo.expandPath, args, bo.apiVersion, defaults)

  const result = await client.query({
    destinationName: endpoint?.destinationName,
    servicePath: bo.odataServicePath,
    entitySet: bo.entitySet,
    filter,
    select: bo.selectFields,
    expand,
    apiVersion: bo.apiVersion,
    top: 200,
    correlationId,
  })

  return { objectCode: bo.objectCode, filter, ...result }
}

/** Apply an approved write. The mock backend has no write endpoint, so this
 *  records the intent and returns it — the ledger pattern the web app uses
 *  against the read-only sandbox. */
async function executeWrite(toolName, args) {
  if (toolName !== 'move_stock') throw new backend.BackendError(`Unknown write tool: ${toolName}`, 400)
  return {
    applied: true,
    toolName,
    ...args,
    note: 'Recorded against the local ledger. The Hub sandbox is read-only; against a real tenant this posts a goods movement.',
  }
}

module.exports = {
  buildExpand, toolNameFor, buildDefinitions, buildFilter, isWriteTool, executeRead, executeWrite, WRITE_TOOLS }
