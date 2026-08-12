#!/usr/bin/env node
/**
 * Check the seed CSVs against each other before they reach a database.
 *
 * `cds deploy` will happily load a business object pointing at an endpoint that
 * does not exist: foreign keys are not enforced on the seed path. The break
 * then surfaces at the first question a user asks, as an opaque failure, rather
 * than here.
 */

const fs = require('node:fs')
const path = require('node:path')

const DATA = path.join(__dirname, '..', 'db', 'data')
const problems = []
const notes = []

/** CSVs here are semicolon-delimited; a value containing one silently shifts
 *  every later column, which is how a description once became an isActive flag. */
function readCsv(file) {
  const full = path.join(DATA, file)
  if (!fs.existsSync(full)) return null
  const lines = fs.readFileSync(full, 'utf8').split('\n').filter((l) => l.trim())
  const header = lines[0].split(';')
  const rows = lines.slice(1).map((line, i) => {
    const cells = line.split(';')
    if (cells.length !== header.length) {
      problems.push(`${file}: row ${i + 1} has ${cells.length} columns, header has ${header.length} — an unescaped ";" in a value?`)
    }
    return Object.fromEntries(header.map((h, j) => [h.trim(), (cells[j] ?? '').trim()]))
  })
  return { header, rows }
}

const endpoints = readCsv('factorypilot.integration-IntegrationEndpoint.csv')
const objects = readCsv('factorypilot.config-BusinessObjectConfig.csv')
const quotas = readCsv('factorypilot.token-QuotaPolicy.csv')
const cache = readCsv('factorypilot.cache-CachePolicy.csv')
const users = readCsv('factorypilot.admin-User.csv')
const scopes = readCsv('factorypilot.admin-UserScope.csv')

// --- referential integrity ---------------------------------------------------

if (endpoints && objects) {
  const known = new Set(endpoints.rows.map((r) => r.ID))
  for (const o of objects.rows) {
    if (o.endpoint_ID && !known.has(o.endpoint_ID)) {
      problems.push(`BusinessObjectConfig ${o.objectCode}: endpoint_ID ${o.endpoint_ID} does not exist`)
    }
    // An active object with no service path is a tool that appears in the
    // catalogue and then fails when called.
    if (o.isActive === 'true' && !o.odataServicePath) {
      problems.push(`BusinessObjectConfig ${o.objectCode}: active but has no odataServicePath`)
    }
    if (o.isActive === 'true' && !o.entitySet) {
      problems.push(`BusinessObjectConfig ${o.objectCode}: active but has no entitySet`)
    }
    const endpoint = endpoints.rows.find((e) => e.ID === o.endpoint_ID)
    if (o.isActive === 'true' && endpoint && endpoint.isActive !== 'true') {
      problems.push(`BusinessObjectConfig ${o.objectCode}: active, but its endpoint "${endpoint.name}" is not`)
    }
  }
}

if (users && scopes) {
  const known = new Set(users.rows.map((r) => r.ID))
  for (const s of scopes.rows) {
    if (s.user_ID && !known.has(s.user_ID)) {
      problems.push(`UserScope ${s.warehouseID}: user_ID ${s.user_ID} does not exist`)
    }
  }
}

// --- values that must be one of a set ---------------------------------------

const oneOf = (rows, file, field, allowed) => {
  for (const r of rows || []) {
    if (r[field] && !allowed.includes(r[field])) {
      problems.push(`${file}: ${field}="${r[field]}" is not one of ${allowed.join(', ')}`)
    }
  }
}

oneOf(endpoints?.rows, 'IntegrationEndpoint', 'kind', ['iflow', 'odata_direct', 'hub_sandbox', 'destination', 'mock'])
oneOf(endpoints?.rows, 'IntegrationEndpoint', 'authMode', ['none', 'api_key', 'bearer', 'basic', 'oauth2_client_credentials'])
oneOf(cache?.rows, 'CachePolicy', 'ttlUnit', ['MINUTES', 'HOURS', 'DAYS'])
oneOf(cache?.rows, 'CachePolicy', 'cacheKeyStrategy', ['PER_USER', 'PER_ROLE', 'GLOBAL'])
oneOf(quotas?.rows, 'QuotaPolicy', 'limitType', ['REQUEST_COUNT', 'TOKEN_COUNT'])

// --- credentials must be names, not values -----------------------------------

const SECRET_SHAPED = /^(sk-|gho_|ghp_|xox[baprs]-|AKIA[0-9A-Z]{16})|^[A-Za-z0-9_\-]{40,}$/
for (const e of endpoints?.rows || []) {
  if (e.credentialRef && SECRET_SHAPED.test(e.credentialRef)) {
    problems.push(`IntegrationEndpoint "${e.name}": credentialRef looks like a secret, not the NAME of an env var`)
  }
  if (e.url && e.url.startsWith('http://') && !e.url.startsWith('http://localhost')) {
    problems.push(`IntegrationEndpoint "${e.name}": url is plain http — credentials would travel in clear`)
  }
  if (e.authMode === 'oauth2_client_credentials' && !e.tokenUrl) {
    problems.push(`IntegrationEndpoint "${e.name}": OAuth2 needs a tokenUrl`)
  }
}

// --- quota sanity ------------------------------------------------------------

for (const q of quotas?.rows || []) {
  const day = Number(q.dailyLimit), week = Number(q.weeklyLimit), month = Number(q.monthlyLimit)
  // A weekly limit below the daily one makes the daily limit unreachable, and
  // the user is blocked for reasons the UI cannot explain.
  if (day && week && week < day) problems.push(`QuotaPolicy ${q.subject}: weekly (${week}) is below daily (${day})`)
  if (week && month && month < week) problems.push(`QuotaPolicy ${q.subject}: monthly (${month}) is below weekly (${week})`)
}

// --- advisory ----------------------------------------------------------------

if (cache?.rows.some((r) => r.cacheKeyStrategy === 'GLOBAL' && !r.description)) {
  problems.push('CachePolicy: GLOBAL key scope without a description — record why sharing one answer across all users is safe here')
}
const activeObjects = (objects?.rows || []).filter((r) => r.isActive === 'true')
if (!activeObjects.length) problems.push('No active business object — the agent would have no tools at all')
notes.push(`${activeObjects.length} active business object(s), ${(endpoints?.rows || []).length} endpoint(s)`)

// --- report ------------------------------------------------------------------

if (problems.length) {
  console.error('✗ Seed data has problems:')
  for (const p of problems) console.error(`    ${p}`)
  process.exit(1)
}
console.log(`✓ Seed data consistent — ${notes.join('; ')}`)
