#!/usr/bin/env node
/**
 * Check xs-app.json against the schema the approuter actually enforces.
 *
 * JSON-valid is not schema-valid: an unrecognised property (a `"//"` comment
 * key, say) parses fine, then kills the approuter on startup with
 * `Additional properties not allowed` — four crash loops and a failed deploy
 * for a typo. This catches it in a second, locally.
 */

const fs = require('node:fs')
const path = require('node:path')

const routerDir = path.join(__dirname, '..', 'app', 'router')
const configPath = path.join(routerDir, 'xs-app.json')
const schemaPath = path.join(
  routerDir,
  'node_modules/@sap/approuter/lib/configuration/schemas/xs-app-schema.json'
)

if (!fs.existsSync(configPath)) {
  console.error(`✗ not found: ${configPath}`)
  process.exit(1)
}

let config
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
  console.error(`✗ xs-app.json is not valid JSON: ${err.message}`)
  process.exit(1)
}

if (!fs.existsSync(schemaPath)) {
  // Without the dependency installed we can still confirm the JSON parses.
  console.log('• approuter not installed — checked JSON syntax only')
  console.log(`  run: (cd ${path.relative(process.cwd(), routerDir)} && npm install)`)
  process.exit(0)
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

/** Find the route object's property list wherever it sits in the schema. */
function routeProperties(node) {
  if (!node || typeof node !== 'object') return null
  if (node.properties && (node.properties.source || node.properties.target)) {
    return Object.keys(node.properties)
  }
  for (const value of Object.values(node)) {
    const found = routeProperties(value)
    if (found) return found
  }
  return null
}

const allowed = routeProperties(schema)
if (!allowed) {
  console.log('• could not locate the route schema — checked JSON syntax only')
  process.exit(0)
}

const problems = []
for (const [i, route] of (config.routes || []).entries()) {
  for (const key of Object.keys(route)) {
    if (!allowed.includes(key)) problems.push(`routes[${i}]: unknown property "${key}"`)
  }
  if (!route.source) problems.push(`routes[${i}]: missing "source"`)
}

if (problems.length) {
  console.error('✗ xs-app.json will be rejected by the approuter:')
  for (const p of problems) console.error(`    ${p}`)
  console.error(`\n  allowed route properties: ${allowed.join(', ')}`)
  process.exit(1)
}

console.log(`✓ xs-app.json valid — ${(config.routes || []).length} routes`)
