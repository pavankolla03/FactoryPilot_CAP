#!/usr/bin/env node
/**
 * Call the SAP Business Accelerator Hub sandbox for every registered business
 * object and report what actually comes back.
 *
 * This is the one dependency the delivery plan never satisfied. Every fixture
 * in the repo is generated, so the field names in `selectFields` and
 * `defaultFilters` are educated guesses against the published OData services —
 * correct in principle, unverified in fact. A guess that is wrong produces an
 * empty answer, which reads as "there is no stock" rather than "my column name
 * was wrong".
 *
 * So this does three things, in increasing order of usefulness:
 *   1. proves the key and the network path work at all;
 *   2. prints the field names the service really returns, next to the ones the
 *      registry asks for, and names any that do not exist;
 *   3. with --capture, writes the real response beside the synthetic one so the
 *      mock can replay genuine data.
 *
 *   node scripts/hub-probe.js                 # probe every active object
 *   node scripts/hub-probe.js MATERIAL_STOCK  # just one
 *   node scripts/hub-probe.js --capture       # also save the payloads
 *
 * Needs SAP_HUB_API_KEY. Nothing here is committed automatically and the key is
 * never written to disk.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CSV = path.join(ROOT, 'apps/cap/db/data/factorypilot.config-BusinessObjectConfig.csv')
const EP_CSV = path.join(ROOT, 'apps/cap/db/data/factorypilot.integration-IntegrationEndpoint.csv')
const HUB_ROOT = 'https://sandbox.api.sap.com/s4hanacloud'
const TIMEOUT_MS = 20000

const args = process.argv.slice(2)
const capture = args.includes('--capture')
const only = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase())

function requireKey() {
  if (process.env.SAP_HUB_API_KEY) return process.env.SAP_HUB_API_KEY
  console.error(`
No SAP_HUB_API_KEY set.

  1. Sign in at https://api.sap.com
  2. Open any S/4HANA Cloud API, e.g. "Material Stock"
  3. Copy the API key from the "Try Out" panel
  4. export SAP_HUB_API_KEY='...'   (never commit it)

See docs/api/hub/DAY1_MANUAL_CHECKLIST.md.
`)
  process.exit(2)
}

/** Which local fixture directory belongs to which object, for --capture. */
const FIXTURE_DIR = {
  DELIVERY: 'delivery',
  MATERIAL_STOCK: 'material_stock',
  MATERIAL_DOCUMENT: 'material_document',
  PHYSICAL_INVENTORY: 'physical_inventory',
  PURCHASING: 'purchasing',
}

/** Semicolon-delimited, but a quoted value may legitimately contain one — an
 *  $expand separates its own options that way. A naive split shifted every
 *  column after expandPath and read a field list as an isActive flag. */
function splitCsvLine(line) {
  const cells = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cell += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ';' && !inQuotes) {
      cells.push(cell); cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells
}

function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n')
  const cols = splitCsvLine(header)
  return lines.map((line) =>
    Object.fromEntries(splitCsvLine(line).map((v, i) => [(cols[i] || '').trim(), (v ?? '').trim()]))
  )
}

/** Only the objects actually routed to the Hub.
 *
 *  Some are served by SAP Graph now (see scripts/graph-probe.js). Probing those
 *  against the Hub asks for a Graph namespace on a Hub host and reports a 404 —
 *  a health check that invents failures is worse than none. */
function readObjects() {
  const hub = readCsv(EP_CSV).find((e) => e.kind === 'hub_sandbox' && e.isActive === 'true')
  return readCsv(CSV)
    .filter((o) => o.isActive === 'true')
    .filter((o) => !hub || !o.endpoint_ID || o.endpoint_ID === hub.ID)
    .filter((o) => !only.length || only.includes(o.objectCode))
}

const rowsOf = (body) =>
  body?.d?.results ?? (Array.isArray(body?.d) ? body.d : Array.isArray(body?.value) ? body.value : [])

async function probe(bo) {
  // Ask for a couple of rows only: the point is the shape, not the volume, and
  // the sandbox is shared with everyone else trying the same thing.
  const url = `${HUB_ROOT}${bo.odataServicePath}/${bo.entitySet}?$top=2&$format=json`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res
  try {
    res = await fetch(url, {
      headers: { APIKey: requireKey(), Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (err) {
    return { ok: false, url, detail: err.name === 'AbortError' ? `no response within ${TIMEOUT_MS}ms` : err.message }
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  if (!res.ok) {
    // Observed against the live sandbox: an invalid key is 401
    // ("oauth.v2.InvalidApiKey"), not 403. Saying which of the key and the
    // path is at fault saves the reader from doubting both.
    const hint =
      res.status === 401 ? ' — the key is wrong or expired; the path was accepted'
      : res.status === 403 ? ' — the key is valid but not entitled to this API'
      : res.status === 404 ? ' — the service path or entity set does not exist'
      : ''
    return { ok: false, url, detail: `HTTP ${res.status}${hint}: ${text.slice(0, 160)}` }
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, url, detail: 'the sandbox returned a non-JSON body' }
  }

  const rows = rowsOf(body)
  return { ok: true, url, rows, body, fields: rows.length ? Object.keys(rows[0]) : [] }
}

/** The whole point: do the names we query by actually exist upstream? */
function checkFields(bo, actual) {
  const known = new Set(actual)
  const wanted = (bo.selectFields || '').split(',').map((s) => s.trim()).filter(Boolean)
  const filtered = [...(bo.defaultFilters || '').matchAll(/(\w+)\s+eq\s+/g)].map((m) => m[1])

  return {
    missingSelect: wanted.filter((f) => !known.has(f)),
    missingFilter: filtered.filter((f) => !known.has(f)),
    unusedButPresent: actual.filter((f) => !f.startsWith('__') && !wanted.includes(f)).slice(0, 8),
  }
}

async function main() {
  requireKey()
  const objects = readObjects()
  if (!objects.length) {
    console.error(only.length ? `No active business object matches ${only.join(', ')}.` : 'No active business objects.')
    process.exit(1)
  }

  console.log(`Probing ${objects.length} object(s) against the Hub sandbox.\n`)
  let failures = 0
  let mismatches = 0

  for (const bo of objects) {
    const result = await probe(bo)
    process.stdout.write(`${bo.objectCode}  ${bo.entitySet}\n`)

    if (!result.ok) {
      failures++
      console.log(`  ✗ ${result.detail}`)
      console.log(`    ${result.url}\n`)
      continue
    }

    console.log(`  ✓ ${result.rows.length} row(s) returned`)

    if (!result.rows.length) {
      // Not a failure: the shared sandbox is often empty for an entity set.
      // It just means the field check below cannot run.
      console.log('    (sandbox has no rows here, so field names cannot be checked)\n')
      continue
    }

    const { missingSelect, missingFilter, unusedButPresent } = checkFields(bo, result.fields)
    if (missingSelect.length || missingFilter.length) {
      mismatches++
      if (missingFilter.length) console.log(`    ✗ filter fields that do not exist: ${missingFilter.join(', ')}`)
      if (missingSelect.length) console.log(`    ✗ select fields that do not exist: ${missingSelect.join(', ')}`)
      console.log(`    available: ${unusedButPresent.join(', ')}${result.fields.length > 8 ? ', …' : ''}`)
    } else {
      console.log('    ✓ every configured filter and select field exists upstream')
    }

    if (capture) {
      const dir = FIXTURE_DIR[bo.objectCode]
      if (!dir) {
        console.log('    (no fixture directory mapped, not captured)')
      } else {
        const target = path.join(ROOT, 'docs/api/hub', dir, 'sample_response.json')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, JSON.stringify(result.body, null, 2) + '\n')
        console.log(`    captured → ${path.relative(ROOT, target)}`)
      }
    }
    console.log()
  }

  console.log('—')
  if (failures) {
    console.log(`${failures} object(s) could not be reached. The key, the service path or the network is wrong.`)
    process.exit(1)
  }
  if (mismatches) {
    console.log(`${mismatches} object(s) reached the Hub but query fields do not match. Correct them in`)
    console.log('apps/cap/db/data/factorypilot.config-BusinessObjectConfig.csv, then re-run.')
    process.exit(1)
  }
  console.log('Every object reached the Hub and every configured field exists upstream.')
  if (capture) console.log('Captured payloads are real data — review before committing.')
}

// Exported so the field comparison — the part that cannot run without a key —
// is still covered by tests.
module.exports = { checkFields, rowsOf, readObjects }

if (require.main === module) main()
