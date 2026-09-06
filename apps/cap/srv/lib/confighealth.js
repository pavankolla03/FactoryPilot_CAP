/**
 * What is configured, what is missing, and what actually answers.
 *
 * Everything this product needs from its operator arrives as an environment
 * variable or a service binding, and until now the only way to discover that
 * one of them was wrong was to ask a question in the chat window and read the
 * failure. That is the worst possible place to learn it: the message competes
 * with an answer, the person seeing it is usually not the person who can fix
 * it, and a credential that has expired looks exactly like a product that is
 * broken.
 *
 * Two levels, deliberately separated:
 *
 *   checks()  reads process.env and the bindings. No network, so the admin
 *             page can render it immediately.
 *   probe()   actually calls the things. Slower, and therefore something the
 *             page asks for after it has painted.
 *
 * Secret VALUES never leave this module. Presence, length and provenance are
 * all an operator needs to tell "not set" from "set to the wrong thing", and
 * anything more would put credentials in an HTTP response, a browser cache and
 * very likely a screenshot.
 */

const cds = require('@sap/cds')

const cache = require('./cache')
const backend = require('./backend')

const OK = 'ok'
const WARN = 'warn'
const MISSING = 'missing'
const ERROR = 'error'

const isSet = (name) => Boolean(String(process.env[name] || '').trim())
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase())

/** Names of the set ones, so an operator can see which half of a pair is absent. */
function presence(names) {
  const set = names.filter(isSet)
  return { set, missing: names.filter((n) => !isSet(n)), all: set.length === names.length, any: set.length > 0 }
}

// --- the model plane --------------------------------------------------------

function llmChecks() {
  const out = []
  const explicit = (process.env.LLM_PROVIDER || '').toLowerCase()

  // OpenRouter accepts either one key or a comma-separated list; the rotation
  // in llm.js reads both, so reporting only one of them would call a working
  // configuration incomplete.
  const single = isSet('OPENROUTER_API_KEY')
  const list = String(process.env.OPENROUTER_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const keyCount = list.length || (single ? 1 : 0)

  out.push({
    area: 'Language model',
    name: 'OpenRouter',
    status: keyCount > 0 ? OK : MISSING,
    detail:
      keyCount > 1
        ? `${keyCount} keys configured — requests rotate across them when one is rate-limited.`
        : keyCount === 1
          ? 'One key configured. A second key lets the rotation survive a rate limit.'
          : 'No key. Without a model provider the agent cannot answer at all.',
    fix:
      keyCount > 0
        ? truthy(process.env.OPENROUTER_ALLOW_PAID)
          ? 'OPENROUTER_ALLOW_PAID is on — paid models may be billed to this key.'
          : 'Free models only (OPENROUTER_ALLOW_PAID is off).'
        : 'cf set-env <app> OPENROUTER_API_KEYS "key1,key2" — or OPENROUTER_API_KEY for a single key.',
    envVars: 'OPENROUTER_API_KEYS, OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_ALLOW_PAID',
  })

  // SAP-native alternative. Customers who will not send prompts to a
  // third-party gateway ask for this one by name.
  const core = presence(['AICORE_BASE_URL', 'AICORE_DEPLOYMENT_ID', 'AICORE_TOKEN_URL'])
  const coreCreds = presence(['AICORE_CLIENT_ID', 'AICORE_CLIENT_SECRET'])
  out.push({
    area: 'Language model',
    name: 'SAP AI Core (optional)',
    status: core.all && coreCreds.all ? OK : core.any || coreCreds.any ? WARN : MISSING,
    detail:
      core.all && coreCreds.all
        ? `Deployment ${process.env.AICORE_DEPLOYMENT_ID} in resource group ${process.env.AICORE_RESOURCE_GROUP || 'default'}.`
        : core.any || coreCreds.any
          ? `Partly configured — still missing ${[...core.missing, ...coreCreds.missing].join(', ')}. A partial configuration is skipped, not used.`
          : 'Not configured. Optional — only needed for tenants that require inference to stay inside SAP.',
    fix: 'Set AICORE_BASE_URL, AICORE_DEPLOYMENT_ID, AICORE_TOKEN_URL, AICORE_CLIENT_ID, AICORE_CLIENT_SECRET, and point a Model Route at provider "aicore".',
    envVars: 'AICORE_BASE_URL, AICORE_DEPLOYMENT_ID, AICORE_TOKEN_URL, AICORE_RESOURCE_GROUP, AICORE_CLIENT_ID, AICORE_CLIENT_SECRET',
  })

  if (explicit) {
    out.push({
      area: 'Language model',
      name: 'Provider override',
      status: WARN,
      detail: `LLM_PROVIDER is pinned to "${explicit}", so the automatic fallback between providers is disabled.`,
      fix: 'Unset LLM_PROVIDER to let the router fall back when one provider is unavailable.',
      envVars: 'LLM_PROVIDER',
    })
  }
  return out
}

// --- the data plane ---------------------------------------------------------

function sapChecks() {
  const out = []
  const hub = isSet('SAP_HUB_API_KEY')
  out.push({
    area: 'SAP data',
    name: 'Business Accelerator Hub key',
    status: hub ? OK : MISSING,
    detail: hub
      ? `Set (${String(process.env.SAP_HUB_API_KEY).trim().length} characters). Whether it is still valid is a live question — run the connection probe.`
      : 'Not set. Every business object routed through the Hub will fail.',
    fix: 'Sign in at api.sap.com, open any S/4HANA Cloud API, press "Show API Key", then: cf set-env <app> SAP_HUB_API_KEY <key> && cf restage <app>. Hub keys expire — this is the most common cause of a sudden 401.',
    envVars: 'SAP_HUB_API_KEY',
  })

  const graph = presence(['GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'])
  out.push({
    area: 'SAP data',
    name: 'SAP Graph (optional)',
    status: graph.all ? OK : graph.any ? WARN : MISSING,
    detail: graph.all
      ? 'OAuth client configured.'
      : graph.any
        ? `Half configured — ${graph.missing.join(' and ')} still missing.`
        : 'Not configured. Only needed for business objects whose endpoint kind is "graph".',
    fix: 'cf set-env <app> GRAPH_CLIENT_ID <id> && cf set-env <app> GRAPH_CLIENT_SECRET <secret>',
    envVars: 'GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET',
  })

  const demo = truthy(process.env.FACTORYPILOT_DEMO_MODE)
  out.push({
    area: 'SAP data',
    name: 'Demo mode',
    status: demo ? WARN : OK,
    detail: demo
      ? 'ON — answers may come from the bundled fixture rather than a live SAP system. Correct for a demo, wrong for an evaluation of real data.'
      : 'Off — answers come from whatever each business object’s endpoint actually returns.',
    fix: demo ? 'cf unset-env <app> FACTORYPILOT_DEMO_MODE && cf restage <app>' : 'Set FACTORYPILOT_DEMO_MODE=1 to demo without an SAP account.',
    envVars: 'FACTORYPILOT_DEMO_MODE',
  })
  return out
}

// --- state ------------------------------------------------------------------

function stateChecks() {
  const out = []

  const redis = cache.resolveRedis()
  const live = cache.backend === 'redis'
  out.push({
    area: 'State',
    name: 'Redis cache',
    status: live ? OK : redis ? WARN : MISSING,
    detail: live
      ? `Connected to ${redis?.host}:${redis?.port} (${redis?.tls ? 'TLS' : 'plaintext'}, from ${redis?.source}).`
      : redis
        ? `Bound at ${redis.host}:${redis.port} from ${redis.source}, but this instance is not using it — it fell back to the in-process cache. Check the server log for the connect error.`
        : 'Not bound. The in-process cache works, but it is per-instance: two instances will not share a cached answer, and both will hold stale data independently.',
    fix: 'Bind any Redis (SAP, AWS ElastiCache, GCP Memorystore, Azure Cache) and set REDIS_URL, or bind a service whose VCAP credentials carry a redis:// uri. A private CA goes in REDIS_CA_CERT.',
    envVars: 'REDIS_URL, REDIS_CA_CERT, REDIS_TLS_REJECT_UNAUTHORIZED',
  })

  // The CAP db kind is the honest answer to "where does the data live" — the
  // profile decides it, and a production profile that silently resolved to
  // SQLite is a class of mistake this product has already made once.
  const dbKind = cds.env?.requires?.db?.kind || 'unknown'
  out.push({
    area: 'State',
    name: 'Database',
    status: dbKind === 'postgres' || dbKind === 'hana' ? OK : dbKind === 'sqlite' ? WARN : ERROR,
    detail:
      dbKind === 'sqlite'
        ? 'SQLite. Fine for local development; on Cloud Foundry it is a file on an ephemeral disk that every restart discards and no second instance can see.'
        : `${dbKind} — configuration, audit history and job state are durable.`,
    fix: 'Deploy with the production profile and bind a PostgreSQL instance, then: npm run deploy:pg',
    envVars: 'VCAP_SERVICES (binding), NODE_ENV/CDS_ENV profile',
  })

  // No scheduler check here: scheduled jobs and watchers are Beta, and this
  // branch does not carry them. Reporting a switch for a feature that is not
  // installed sends an operator looking for a screen that does not exist.
  return out
}

/** Everything, cheap. No network call, so this is safe on page load. */
function checks() {
  return [...llmChecks(), ...sapChecks(), ...stateChecks()]
}

// --- live probes ------------------------------------------------------------

/**
 * Ask each configured backend whether it will actually answer.
 *
 * A key that is *set* and a key that *works* are different facts, and only the
 * second one matters. This makes the smallest real request each backend
 * accepts — one row — because a probe that cannot fail the way production
 * fails is not a probe.
 */
async function probe({ timeoutMs = 12000 } = {}) {
  const results = []

  const { IntegrationEndpoint } = cds.entities('factorypilot.integration')
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')

  // In demo mode forEndpoint() hands back the fixture adapter whatever the row
  // says, so every probe would come back green while nothing was reached. A
  // probe that cannot fail is worse than no probe: say so instead of passing.
  if (truthy(process.env.FACTORYPILOT_DEMO_MODE)) {
    return [
      {
        name: 'Demo mode is on',
        kind: 'demo',
        status: WARN,
        detail:
          'Every endpoint is answering from the bundled fixture, so no credential and no network path is actually being tested. Unset FACTORYPILOT_DEMO_MODE to probe the real systems.',
        elapsedMs: 0,
      },
    ]
  }

  let endpoints = []
  try {
    endpoints = await SELECT.from(IntegrationEndpoint).where({ isActive: true })
  } catch (err) {
    return [{ name: 'Configuration', kind: 'config', status: ERROR, detail: `Could not read endpoints: ${err.message}`, elapsedMs: 0 }]
  }

  for (const endpoint of endpoints) {
    if (endpoint.kind === 'mock') {
      results.push({
        name: endpoint.name,
        kind: endpoint.kind,
        status: OK,
        detail: 'Bundled fixture — always available, no credential involved.',
        elapsedMs: 0,
      })
      continue
    }

    // Probe through a business object so the request is the same shape the
    // agent makes: the same service path, the same entity set, the same
    // credential. A probe against the bare host proves only that DNS works.
    let object
    try {
      object = await SELECT.one
        .from(BusinessObjectConfig)
        .where({ endpoint_ID: endpoint.ID, isActive: true })
    } catch {
      /* fall through to the unconfigured branch below */
    }

    if (!object) {
      results.push({
        name: endpoint.name,
        kind: endpoint.kind,
        status: WARN,
        detail: 'Active, but no active business object points at it — nothing would ever call it.',
        elapsedMs: 0,
      })
      continue
    }

    const started = Date.now()
    try {
      const adapter = backend.forEndpoint(endpoint)
      const out = await adapter.query({
        servicePath: object.odataServicePath,
        entitySet: object.entitySet,
        apiVersion: object.apiVersion,
        destinationName: endpoint.destinationName,
        // One row. Enough to prove the credential and the path, cheap enough
        // to run whenever somebody opens the page.
        top: 1,
        correlationId: `probe-${Date.now()}`,
      })
      results.push({
        name: endpoint.name,
        kind: endpoint.kind,
        status: OK,
        detail: `${object.entitySet} answered with ${out.rows.length} row(s) in ${out.elapsedMs}ms.`,
        elapsedMs: Date.now() - started,
      })
    } catch (err) {
      results.push({
        name: endpoint.name,
        kind: endpoint.kind,
        // A credential failure is the operator's to fix and is reported as
        // such; anything else may well be the upstream system's problem.
        status: err.statusCode === 401 || err.statusCode === 403 ? MISSING : ERROR,
        detail: err.message,
        elapsedMs: Date.now() - started,
      })
    }
  }

  // Redis, if there is one to reach.
  const redis = cache.resolveRedis()
  if (redis) {
    const started = Date.now()
    try {
      await cache.init()
      results.push({
        name: 'Redis',
        kind: 'cache',
        status: cache.backend === 'redis' ? OK : ERROR,
        detail:
          cache.backend === 'redis'
            ? `Answering at ${redis.host}:${redis.port}.`
            : 'Bound but not connected — the in-process cache is being used instead.',
        elapsedMs: Date.now() - started,
      })
    } catch (err) {
      results.push({ name: 'Redis', kind: 'cache', status: ERROR, detail: err.message, elapsedMs: Date.now() - started })
    }
  }

  // The database, by asking it something only a live connection can answer.
  {
    const started = Date.now()
    try {
      await SELECT.one.from(IntegrationEndpoint).columns('ID')
      results.push({
        name: `Database (${cds.env?.requires?.db?.kind || 'unknown'})`,
        kind: 'db',
        status: OK,
        detail: `Round-trip in ${Date.now() - started}ms.`,
        elapsedMs: Date.now() - started,
      })
    } catch (err) {
      results.push({
        name: 'Database',
        kind: 'db',
        status: ERROR,
        detail: err.message,
        elapsedMs: Date.now() - started,
      })
    }
  }

  void timeoutMs
  return results
}

module.exports = { checks, probe, presence, OK, WARN, MISSING, ERROR }
