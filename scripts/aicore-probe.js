#!/usr/bin/env node
/**
 * Verify SAP AI Core / Generative AI Hub before routing real questions at it.
 *
 * Why a client asks for this: OpenRouter sends their operational questions to a
 * third party. A client who will not accept that runs the same product against
 * a model deployed in their own AI Core tenant — same answers, same audit rows,
 * nothing leaving their SAP estate. Switching is configuration, not a rebuild.
 *
 * Why this script exists: that switch involves five values from three different
 * screens of the BTP cockpit, and getting any one of them wrong fails in a way
 * that does not name the value. A 401 does not say "wrong client secret", and a
 * 404 on the inference path looks identical whether the deployment id is wrong
 * or the deployment is merely not running yet.
 *
 * Layers, stopping at the first failure:
 *
 *   1. config      are all five values present, and do they look right
 *   2. OAuth       does XSUAA issue a token for this client id and secret
 *   3. deployment  does the deployment exist, and is it RUNNING
 *   4. inference   does it answer a real prompt
 *   5. tools       can it call a tool — the whole architecture depends on this
 *
 *   node scripts/aicore-probe.js
 *
 * Reads the same environment variables the app does. Prints no secret.
 */

const path = require('node:path')

const CAP = path.join(__dirname, '..', 'apps', 'cap')
const { AICoreProvider, LLMError } = require(path.join(CAP, 'srv', 'lib', 'llm'))
const oauth = require(path.join(CAP, 'srv', 'lib', 'oauth'))

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', O = '\x1b[0m'
const ok = (s, d) => console.log(`  ${G}PASS${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const bad = (s, d) => console.log(`  ${R}FAIL${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const note = (s) => console.log(`  ${Y}····${O}  ${s}`)

const TIMEOUT = Number(process.env.AICORE_PROBE_TIMEOUT_MS || 30000)

const REQUIRED = [
  ['AICORE_BASE_URL', 'AI API URL from the service key — ends in /v2 or the host root'],
  ['AICORE_DEPLOYMENT_ID', 'the deployment, not the model name — looks like d1234567890abcde'],
  ['AICORE_TOKEN_URL', 'the "url" field of the service key, an authentication.sap.hana.ondemand.com host'],
  ['AICORE_CLIENT_ID', 'clientid from the service key'],
  ['AICORE_CLIENT_SECRET', 'clientsecret from the service key'],
]

async function main() {
  console.log(`\nSAP AI Core probe${D} — timeout ${TIMEOUT}ms${O}\n`)

  // 1 · config -------------------------------------------------------------
  const missing = REQUIRED.filter(([k]) => !process.env[k])
  if (missing.length) {
    bad(`config — ${missing.length} of ${REQUIRED.length} values are not set`,
      missing.map(([k, why]) => `${k.padEnd(22)} ${why}`).join('\n        '))
    console.log(`\n  ${D}All five come from one place: BTP cockpit → Instances and Subscriptions →`)
    console.log(`  your AI Core instance → Service Keys. The deployment id comes from AI Launchpad`)
    console.log(`  → ML Operations → Deployments. See docs/deployment/SAP_AI_CORE.md.${O}\n`)
    process.exit(1)
  }
  const resourceGroup = process.env.AICORE_RESOURCE_GROUP || 'default'
  ok('config — all five values are set',
    `base ${process.env.AICORE_BASE_URL}\n        deployment ${process.env.AICORE_DEPLOYMENT_ID}\n` +
    `        resource group ${resourceGroup}`)

  if (/\/v2\/?$/.test(process.env.AICORE_BASE_URL) === false)
    note('AICORE_BASE_URL does not end in /v2 — that is usually right, the client appends it. ' +
      'If inference 404s below, this is the first thing to check.')

  let provider
  try {
    provider = new AICoreProvider({
      baseUrl: process.env.AICORE_BASE_URL,
      deploymentId: process.env.AICORE_DEPLOYMENT_ID,
      tokenUrl: process.env.AICORE_TOKEN_URL,
      resourceGroup,
      timeoutMs: TIMEOUT,
    })
  } catch (err) {
    bad('config — the provider refused to construct', err.message)
    process.exit(1)
  }

  // 2 · OAuth --------------------------------------------------------------
  let token
  try {
    token = await oauth.getToken(provider.tokenEndpoint, { force: true })
    ok('OAuth — XSUAA issued a token', `token endpoint ${provider.tokenEndpoint.tokenUrl}`)
  } catch (err) {
    // oauth.js already names the underlying cause (ENOTFOUND, ECONNREFUSED, a
    // certificate rejection) in its message, so match on that rather than
    // walking the chain again and printing everything twice.
    const detail = err.message
    bad('OAuth — no token was issued',
      /401|invalid_client/i.test(detail)
        ? 'The client id or secret is wrong. Copy them from the service key rather than retyping.'
        : /ENOTFOUND|EAI_AGAIN/i.test(detail)
          ? `The token host does not resolve. AICORE_TOKEN_URL should be the "url" field of the service key.`
          : /ECONNREFUSED|ETIMEDOUT|CERT/i.test(detail)
            ? `Could not reach the token host: ${detail}`
            : detail)
    process.exit(1)
  }

  // 3 · deployment ---------------------------------------------------------
  // Checked separately from inference because "not running yet" and "wrong id"
  // both return 404 on the inference path, and they need different responses:
  // one is waiting, the other is a typo.
  const root = process.env.AICORE_BASE_URL.replace(/\/$/, '').replace(/\/v2$/, '')
  try {
    const res = await fetch(`${root}/v2/lm/deployments/${process.env.AICORE_DEPLOYMENT_ID}`, {
      headers: { Authorization: `Bearer ${token}`, 'AI-Resource-Group': resourceGroup },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.ok) {
      const d = await res.json()
      if (d.status === 'RUNNING') ok(`deployment — RUNNING`, `${d.configurationName || d.id}${d.details?.resources?.backendDetails?.model?.name ? ` · model ${d.details.resources.backendDetails.model.name}` : ''}`)
      else { bad(`deployment — status is ${d.status}`, 'Only a RUNNING deployment serves inference. Start it in AI Launchpad and wait.'); process.exit(1) }
    } else if (res.status === 404) {
      bad('deployment — not found',
        `No deployment ${process.env.AICORE_DEPLOYMENT_ID} in resource group "${resourceGroup}". ` +
        'Check the id, and check the resource group — a deployment in another group is invisible here.')
      process.exit(1)
    } else if (res.status === 403) {
      bad('deployment — forbidden', 'The token is valid but this service key lacks access to that resource group.')
      process.exit(1)
    } else {
      note(`deployment — the management API answered ${res.status}; continuing to inference anyway`)
    }
  } catch (err) {
    note(`deployment — could not be checked (${err.message}); continuing to inference`)
  }

  // 4 · inference ----------------------------------------------------------
  try {
    const r = await provider.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 20, timeoutMs: TIMEOUT,
    })
    ok('inference — the deployment answered',
      `"${String(r.text).trim().slice(0, 60)}" · ${r.totalTokens} tokens${r.isEstimated ? ' (estimated)' : ''}`)
  } catch (err) {
    bad('inference — the call failed',
      /404/.test(err.message)
        ? 'The inference path was not found. Either AICORE_BASE_URL has the wrong shape, or this deployment ' +
          'does not serve chat/completions — a non-chat model will not work here.'
        : err.message)
    process.exit(1)
  }

  // 5 · tools --------------------------------------------------------------
  // The product is a tool-calling loop. A model that cannot call a tool will
  // answer warehouse questions out of thin air, which is worse than refusing.
  try {
    const r = await provider.complete({
      messages: [{ role: 'user', content: 'How much stock of material P123 is in plant 1710? Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'query_material_stock',
          description: 'Read material stock from S/4HANA',
          parameters: {
            type: 'object',
            properties: { material: { type: 'string' }, plant: { type: 'string' } },
            required: ['material', 'plant'],
          },
        },
      }],
      maxTokens: 200, timeoutMs: TIMEOUT,
    })
    if (r.toolCalls?.length) {
      ok('tools — the model called the tool', `${r.toolCalls[0].name}(${JSON.stringify(r.toolCalls[0].arguments)})`)
    } else {
      bad('tools — the model answered without calling the tool',
        'This deployment is not usable. Every grounded answer in IntelliOps4 comes from a tool call; a model ' +
        'that will not call one produces confident, unsourced answers. Deploy a tool-calling model instead.')
      process.exit(1)
    }
  } catch (err) {
    bad('tools — the tool-calling request failed', err.message)
    process.exit(1)
  }

  console.log(`\n${G}This AI Core deployment is usable.${O} To route traffic to it, set a ModelRoute`)
  console.log(`with provider ${D}aicore${O} in Admin → Model Routes, or pin it with LLM_PROVIDER=aicore.\n`)
}

main().catch((err) => {
  console.error(`\n${R}probe crashed:${O} ${err instanceof LLMError ? err.message : err.stack || err.message}\n`)
  process.exit(1)
})
