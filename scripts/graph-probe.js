#!/usr/bin/env node
/**
 * Call SAP Graph for every business object routed through it, and report what
 * actually comes back.
 *
 * The sibling of hub-probe.js, and it exists for the same reason: the registry
 * describes each object with an entity name, a filter template and a field
 * list, and every one of those is a claim about a system this repo cannot see.
 * A wrong entity name or a field that does not exist upstream produces an empty
 * answer — which reads as "there is no stock" rather than "I asked for a column
 * that isn't there".
 *
 * It also answers the question a client will ask when they add a sixth object:
 * *did my new row work?* Add the row, run this, see rows come back.
 *
 *   node scripts/graph-probe.js                 # every Graph-backed object
 *   node scripts/graph-probe.js MATERIAL_STOCK  # just one
 *   node scripts/graph-probe.js --plant 1010    # against a different plant
 *   node scripts/graph-probe.js --entities      # list what the namespace exposes
 *
 * Needs GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET. Neither is written to disk.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'apps/cap')
const BO_CSV = path.join(APP, 'db/data/factorypilot.config-BusinessObjectConfig.csv')
const EP_CSV = path.join(APP, 'db/data/factorypilot.integration-IntegrationEndpoint.csv')

const backend = require(path.join(APP, 'srv/lib/backend'))
const tools = require(path.join(APP, 'srv/lib/tools'))

const argv = process.argv.slice(2)
const listEntities = argv.includes('--entities')
const plantIdx = argv.indexOf('--plant')
const plant = plantIdx > -1 ? argv[plantIdx + 1] : '1710'
const only = argv
  .filter((a, i) => !a.startsWith('--') && i !== plantIdx + 1)
  .map((s) => s.toUpperCase())

/** Semicolon-delimited, but a quoted value may legitimately contain one — an
 *  $expand separates its options that way. */
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
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]))
  })
}

function requireCredentials(endpoint) {
  const ref = endpoint.credentialRef
  const missing = [`${ref}_CLIENT_ID`, `${ref}_CLIENT_SECRET`].filter((v) => !process.env[v])
  if (!missing.length) return
  console.error(`Not set: ${missing.join(' and ')}.\n`)
  console.error('  These come from the Integration Suite service key:')
  console.error('    cf service-key Iflow ServiceKey')
  console.error('  then export the oauth.clientid and oauth.clientsecret it prints:')
  console.error(`    export ${ref}_CLIENT_ID='sb-...'`)
  console.error(`    export ${ref}_CLIENT_SECRET='...'`)
  console.error('\n  On the deployed app they are set with cf set-env and never committed.')
  process.exit(1)
}

;(async () => {
  const endpoint = readCsv(EP_CSV).find((e) => e.kind === 'graph' && e.isActive === 'true')
  if (!endpoint) {
    console.error('No active endpoint of kind "graph" in the registry.')
    process.exit(1)
  }
  requireCredentials(endpoint)

  // The registry stores timeoutMs as text; the adapter wants a number.
  endpoint.timeoutMs = Number(endpoint.timeoutMs) || 20000
  const client = new backend.GraphBackend(endpoint)

  console.log(`SAP Graph  ${endpoint.url}`)
  console.log(`plant ${plant}\n`)

  if (listEntities) {
    // Straight at the namespace: what can a new row actually name?
    const ns = (readCsv(BO_CSV).find((b) => b.endpoint_ID === endpoint.ID)?.odataServicePath || '/sap.s4')
      .replace(/^\/+/, '')
    const res = await client.query({ servicePath: '', entitySet: ns, top: 0 })
    for (const e of res.rows) console.log('  ', e.name || e.url || JSON.stringify(e))
    console.log(`\n${res.rows.length} entities available to register.`)
    return
  }

  const objects = readCsv(BO_CSV)
    .filter((b) => b.endpoint_ID === endpoint.ID && b.isActive === 'true')
    .filter((b) => !only.length || only.includes(b.objectCode))

  if (!objects.length) {
    console.error(only.length ? `No Graph-backed object matched ${only.join(', ')}.` : 'No object is routed to Graph.')
    process.exit(1)
  }

  let failures = 0
  for (const bo of objects) {
    const args = { warehouseID: plant }
    const filter = tools.buildFilter(bo.defaultFilters, args, bo.apiVersion, {})
    const expand = tools.buildExpand(bo.expandPath, args, bo.apiVersion, {})

    console.log(`${bo.objectCode}  ${bo.entitySet}`)
    try {
      const res = await client.query({
        servicePath: bo.odataServicePath,
        entitySet: bo.entitySet,
        filter,
        select: bo.selectFields,
        expand,
        top: 5,
        correlationId: 'graph-probe',
      })
      if (!res.rows.length) {
        console.log(`  ⚠ reached Graph but 0 rows for  ${filter || '(no filter)'}`)
        console.log('    Not necessarily broken — this plant may simply have no data.')
      } else {
        console.log(`  ✓ ${res.rows.length} row(s) in ${res.elapsedMs}ms`)
        // The point of the exercise: do the fields the registry asks for exist?
        const returned = new Set(Object.keys(res.rows[0]))
        const wanted = [
          ...String(bo.selectFields || '').split(','),
          ...[...String(bo.expandPath || '').matchAll(/\$select=([^;)]*)/g)].flatMap((m) => m[1].split(',')),
        ].map((f) => f.trim()).filter(Boolean)
        const absent = wanted.filter((f) => !returned.has(f))
        if (absent.length) {
          console.log(`    ✗ asked for, not returned: ${absent.join(', ')}`)
          failures++
        } else {
          console.log('    ✓ every configured field came back')
        }
      }
    } catch (err) {
      console.log(`  ✗ ${err.message.slice(0, 200)}`)
      failures++
    }
    console.log()
  }

  console.log('—')
  console.log(
    failures
      ? `${failures} object(s) need attention.`
      : 'Every Graph-backed object answered and every configured field exists upstream.'
  )
  process.exitCode = failures ? 1 : 0
})().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
