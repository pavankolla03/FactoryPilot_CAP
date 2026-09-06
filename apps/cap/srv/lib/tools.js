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
/**
 * Turn a preset into the window it means.
 *
 * Single days and ranges are the same shape — `{from, to}` — so a filter
 * template never has to care which kind of preset it was given. "today" is
 * simply the range whose ends are equal, which is what keeps every existing
 * template working unchanged.
 *
 * Weeks start on Monday: an operations week does, and a Sunday-start week puts
 * "last week" one day out from what the person asking meant.
 */
function dateRange(preset, now = new Date()) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const shift = (d, n) => { const c = day(d); c.setDate(c.getDate() + n); return c }
  const today = day(now)
  // getDay(): 0 is Sunday. Monday-based offset.
  const mondayOffset = (today.getDay() + 6) % 7
  const thisMonday = shift(today, -mondayOffset)

  switch (String(preset || 'today').toLowerCase()) {
    case 'yesterday':    return { from: shift(today, -1), to: shift(today, -1) }
    case 'tomorrow':     return { from: shift(today, 1),  to: shift(today, 1) }
    case 'last_7_days':  return { from: shift(today, -6), to: today }
    case 'last_30_days': return { from: shift(today, -29), to: today }
    case 'this_week':    return { from: thisMonday, to: today }
    case 'last_week':    return { from: shift(thisMonday, -7), to: shift(thisMonday, -1) }
    case 'this_month':   return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: today }
    case 'last_month': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return { from: first, to: new Date(today.getFullYear(), today.getMonth(), 0) }
    }
    default:             return { from: today, to: today }
  }
}

function buildFilter(template, args, apiVersion, defaults = {}) {
  if (!template) return ''
  const preset = String(args.datePreset || 'today').toLowerCase()
  const { from, to } = dateRange(preset)
  // Local date parts, not toISOString(): that converts to UTC first, so
  // anywhere east of Greenwich "today" became tomorrow's date after 00:00 local
  // and every same-day filter silently asked about the wrong day.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const asDate = (d) => (apiVersion === 'v2' ? `datetime'${iso(d)}T00:00:00'` : iso(d))
  const isoDay = iso(to)

  const values = {
    // `today` and `date` remain the *end* of the window, which is identical to
    // the old behaviour for the single-day presets every existing template uses.
    today: asDate(to),
    date: asDate(to),
    // New, for templates that want a window rather than a day.
    fromDate: asDate(from),
    toDate: asDate(to),
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
          // Ranges as well as days, so a question about *why* something
          // changed can look at the period it changed over, and a comparison
          // can call this tool twice with two presets. Without a window, every
          // question was implicitly "right now", which cannot answer "why".
          datePreset: {
            type: 'string',
            enum: ['today', 'yesterday', 'tomorrow', 'last_7_days', 'last_30_days',
                   'this_week', 'last_week', 'this_month', 'last_month'],
            description: 'Which period to report on. Use a range for trends, comparisons, ' +
              'or when asked why something changed. Call this tool twice with two presets to compare periods.',
          },
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

  // The page size is reported alongside the rows, because the caller cannot
  // otherwise tell "there are exactly this many" from "this is as many as we
  // asked for". Every bundled fixture is smaller than this, so the difference
  // is invisible until a real tenant answers.
  const PAGE = 200

  const result = await client.query({
    destinationName: endpoint?.destinationName,
    servicePath: bo.odataServicePath,
    entitySet: bo.entitySet,
    filter,
    select: bo.selectFields,
    expand,
    apiVersion: bo.apiVersion,
    top: PAGE,
    correlationId,
  })

  // Which system actually answered, in the log, on every call.
  //
  // Until now the only way to tell whether a question reached SAP Graph or the
  // Hub was to read SessionLog in the database — so "is it really hitting
  // Graph?" was unanswerable from `cf logs`, which is where anyone looks first.
  // The URL is already recorded per request; this makes it visible live.
  cds.log('backend').info(
    `${bo.objectCode} via ${client.name} → ${result.rows.length} row(s) in ${result.elapsedMs}ms · ${result.url}`
  )

  // A full page means the total is unknown, not that it equals the page size.
  // Reported rather than inferred downstream, so the one place that knows the
  // page size is the one that says whether it was reached.
  return { objectCode: bo.objectCode, filter, ...result, pageSize: PAGE, atPageLimit: result.rows.length >= PAGE }
}

/** Apply an approved write. The mock backend has no write endpoint, so this
 *  records the intent and returns it — the ledger pattern the web app uses
 *  against the read-only sandbox. */
/**
 * Apply a confirmed write.
 *
 * Today nothing reaches SAP: the Business Accelerator Hub sandbox this tenant
 * reads from is read-only, so there is no endpoint to post to. That is a fact
 * about the environment, not a decision, and the important thing is that it is
 * never *reported* as though the write had landed.
 *
 * So the result distinguishes two things that were previously one:
 *
 *   `applied`     the action was consumed and recorded — always true on success
 *   `postedToSap` a goods movement actually reached a backend — false today
 *
 * They were a single `applied: true`, which combined with an answer beginning
 * "— done." read as a completed posting to anyone who did not reach the end of
 * the sentence. An operator who believes stock moved when it did not is a worse
 * outcome than an operator who is told plainly that it did not.
 *
 * When a writable endpoint exists, this is where it plugs in: resolve it the
 * way `executeRead` does, post, and set `postedToSap` from the response.
 */
async function executeWrite(toolName, args) {
  if (toolName !== 'move_stock') throw new backend.BackendError(`Unknown write tool: ${toolName}`, 400)

  const { IntegrationEndpoint } = cds.entities('factorypilot.integration')
  let writable = null
  try {
    writable = await SELECT.one.from(IntegrationEndpoint)
      .where({ isActive: true, httpMethod: 'POST' })
  } catch {
    /* no endpoint table, or nothing configured — handled as "not posted" below */
  }

  if (!writable) {
    return {
      applied: true,
      postedToSap: false,
      toolName,
      ...args,
      note:
        'Recorded here and audited, but NOT posted to SAP — no writable endpoint is configured, ' +
        'and the Accelerator Hub sandbox this tenant reads from is read-only. ' +
        'Stock in SAP is unchanged.',
    }
  }

  // A writable endpoint is configured but posting is not implemented yet.
  // Saying so is the only honest option: silently treating it as posted is the
  // failure this whole module is arranged to prevent.
  return {
    applied: true,
    postedToSap: false,
    toolName,
    ...args,
    note:
      `Recorded here and audited, but NOT posted to SAP. A writable endpoint ` +
      `("${writable.name}") is configured; posting through it is not implemented yet. ` +
      'Stock in SAP is unchanged.',
  }
}

module.exports = {
  buildExpand, toolNameFor, buildDefinitions, buildFilter, dateRange,
  isWriteTool, executeRead, executeWrite, WRITE_TOOLS }
