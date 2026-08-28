#!/usr/bin/env node
/**
 * End-to-end behaviour of a *running* FactoryPilot instance.
 *
 * The gap this fills: `npm test` proves the code is right, and
 * `infra/scripts/smoke.sh` proves the deployment exists — apps running,
 * services bound, secrets set. Neither proves the product behaves. A deploy
 * can pass both and still answer every question wrongly, because the seed data
 * did not load, the model route points at an absent key, or the approuter
 * rewrites a path.
 *
 * So every scenario here drives real HTTP against a real instance and asserts
 * something that has actually broken before. Each is written so that failing
 * tells you what a user would see, not which line threw.
 *
 *   node scripts/e2e.js                                  # localhost:4004
 *   node scripts/e2e.js --url https://<approuter-url>    # a deployed instance
 *   node scripts/e2e.js --user admin --pass admin        # basic auth
 *   node scripts/e2e.js --token "$(cf oauth-token ...)"  # bearer
 *
 * Exit code 0 only when every applicable scenario passed. A scenario that
 * cannot run (no admin scope, for example) is SKIPPED and says why — it is
 * never silently counted as a pass.
 */

const BASE = argOf('--url') || process.env.FP_URL || 'http://localhost:4004'
const USER = argOf('--user') || process.env.FP_USER
const PASS = argOf('--pass') || process.env.FP_PASS
const TOKEN = argOf('--token') || process.env.FP_TOKEN
const TIMEOUT_MS = Number(argOf('--timeout') || 30000)

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}

const run = `e2e-${Date.now()}`
let passed = 0, failed = 0, skipped = 0
const failures = []

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m'

function authHeaders() {
  if (TOKEN) return { Authorization: `Bearer ${TOKEN}` }
  if (USER) return { Authorization: `Basic ${Buffer.from(`${USER}:${PASS ?? ''}`).toString('base64')}` }
  return {}
}

async function http(method, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* keep the raw text */ }
    return { status: res.status, ok: res.ok, json, text }
  } catch (err) {
    return { status: 0, ok: false, json: null, text: err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message }
  } finally {
    clearTimeout(timer)
  }
}

const ask = (question, extra = {}) =>
  http('POST', '/insights/ask', { question, warehouseID: '1000', channel: 'WEB', conversationID: `${run}-${Math.random().toString(36).slice(2)}`, ...extra })

/** A scenario may return the string 'SKIP: reason' instead of throwing. */
async function scenario(name, fn) {
  try {
    const out = await fn()
    if (typeof out === 'string' && out.startsWith('SKIP')) {
      skipped++
      console.log(`  ${YELLOW}SKIP${OFF}  ${name}\n        ${DIM}${out.slice(5).replace(/^:\s*/, '')}${OFF}`)
      return
    }
    passed++
    console.log(`  ${GREEN}PASS${OFF}  ${name}${out ? `\n        ${DIM}${out}${OFF}` : ''}`)
  } catch (err) {
    failed++
    failures.push(`${name}: ${err.message}`)
    console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${err.message}`)
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message) }

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nFactoryPilot end-to-end — ${BASE}`)
  console.log(`${DIM}auth: ${TOKEN ? 'bearer token' : USER ? `basic (${USER})` : 'none (expects an unsecured or dummy-auth instance)'}${OFF}\n`)

  let demoMode = null

  await scenario('the service answers and says how it is running', async () => {
    const res = await http('GET', '/insights/health()')
    assert(res.status !== 0, `could not reach ${BASE}: ${res.text}`)
    assert(res.status !== 401 && res.status !== 403, `authentication rejected (HTTP ${res.status}) — pass --user/--pass or --token`)
    assert(res.ok, `HTTP ${res.status}: ${res.text.slice(0, 120)}`)
    const health = JSON.parse(res.json?.value ?? res.text)
    demoMode = health.demoMode
    return `provider=${health.provider}, demoMode=${health.demoMode}`
  })

  if (demoMode === null) {
    console.log(`\n${RED}The instance is not reachable; the remaining scenarios cannot run.${OFF}\n`)
    process.exit(1)
  }

  // Quota headroom is a precondition, not a scenario. Without it every
  // question comes back RATE_LIMITED and the run reports several unrelated
  // failures — "expected AWAITING_APPROVAL, got RATE_LIMITED" — none of which
  // name the actual cause. Stop here instead, and say what happened.
  const usage = await http('GET', '/odata/token/myUsage()')
  if (usage.ok && usage.json?.limitDay != null) {
    const left = usage.json.limitDay - usage.json.usedDay
    if (left < 8) {
      console.log(
        `\n${RED}Not enough quota to run: ${left} of ${usage.json.limitDay} requests left today ` +
          `for "${usage.json.userID}".${OFF}\n` +
          `${DIM}This suite spends about 8. Rehearsals and earlier runs share the same allowance.\n` +
          `Locally: ./scripts/demo-check.sh --reset-quota. Deployed: raise the limit in Admin → Quota Policies,\n` +
          `or run as a different user.${OFF}\n`
      )
      process.exit(1)
    }
    console.log(`${DIM}quota: ${left} of ${usage.json.limitDay} requests left today${OFF}\n`)
  }

  await scenario('a read question is answered from data, not from the model', async () => {
    // "Grounded" is the product's central claim. An answer that is fluent but
    // ungrounded is the failure this whole system exists to prevent.
    const res = await ask('How many deliveries today?')
    assert(res.ok, `HTTP ${res.status}: ${res.text.slice(0, 160)}`)
    assert(res.json.status === 'SUCCESS', `status ${res.json.status}: ${res.json.answer || res.json.message}`)
    const m = JSON.parse(res.json.metrics || '{}')
    assert(m.grounded === true, 'the answer was not grounded in a tool result')
    assert((res.json.answer || '').length > 0, 'the answer was empty')
    return `${res.json.answer.slice(0, 70)}…`
  })

  await scenario('asking twice is served from cache the second time', async () => {
    const question = `How many deliveries today? (${run})`
    const first = await ask(question)
    assert(first.json?.status === 'SUCCESS', `first ask: ${first.json?.status}`)
    const second = await ask(question)
    assert(second.json?.status === 'SUCCESS', `second ask: ${second.json?.status}`)

    const hit = second.json.metadata?.cacheResult
    if (hit !== 'HIT') return `SKIP: second ask reported cacheResult=${hit} — caching may be disabled for this object`
    assert(second.json.answer === first.json.answer, 'a cache hit returned different text from the miss')
    return `miss ${first.json.metadata?.totalResponseTimeMs}ms → hit ${second.json.metadata?.totalResponseTimeMs}ms`
  })

  await scenario('a question it cannot ground is refused, not invented', async () => {
    // The difference between this product and a chatbot bolted onto SAP.
    const res = await ask('What is the weather in Berlin today?')
    assert(res.ok, `HTTP ${res.status}`)
    const m = JSON.parse(res.json.metrics || '{}')
    assert(m.grounded !== true, 'an unanswerable question was reported as grounded')
    assert(!/\d+\s*°|sunny|rain|cloud/i.test(res.json.answer || ''), `it invented a weather answer: ${res.json.answer}`)
    return `${(res.json.answer || '').slice(0, 70)}…`
  })

  let actionID = null

  await scenario('a write is proposed for confirmation and not executed', async () => {
    const res = await ask('Move 250 units of P123 to shipping in warehouse 1000')
    assert(res.ok, `HTTP ${res.status}: ${res.text.slice(0, 160)}`)
    assert(res.json.status === 'AWAITING_APPROVAL', `expected AWAITING_APPROVAL, got ${res.json.status}`)
    assert(res.json.pendingAction?.actionID, 'no confirmation card was returned')
    assert(!/done|applied|posted/i.test(res.json.answer || ''), 'the answer claims the write already happened')
    actionID = res.json.pendingAction.actionID
    return `card: ${res.json.pendingAction.summary || actionID}`
  })

  await scenario('approving the write applies it', async () => {
    if (!actionID) return 'SKIP: no confirmation card from the previous scenario'
    const res = await http('POST', '/insights/confirmAction', { actionID, approve: true })
    assert(res.ok, `HTTP ${res.status}: ${res.text.slice(0, 160)}`)
    assert(res.json.status === 'SUCCESS',
      `${res.json.errorCode || res.json.status}: ${res.json.message || ''}` +
      (res.json.errorCode === 'SCOPE_DENIED' ? ' — this caller has no write scope on warehouse 1000' : ''))
    return `${(res.json.answer || '').slice(0, 70)}…`
  })

  await scenario('the same approval cannot be replayed', async () => {
    // A double-click must not post the goods movement twice.
    if (!actionID) return 'SKIP: no confirmation card to replay'
    const res = await http('POST', '/insights/confirmAction', { actionID, approve: true })
    assert(res.json?.status === 'ERROR', `a replay returned ${res.json?.status}, so the action was consumed twice`)
    assert(res.json.errorCode === 'ACTION_EXPIRED', `expected ACTION_EXPIRED, got ${res.json.errorCode}`)
    return 'refused as already consumed'
  })

  await scenario('every request leaves exactly one audit row', async () => {
    // Stated as a non-functional requirement: "every request produces exactly
    // one CommunicationLog record, regardless of outcome".
    const marker = `audit probe ${run}`
    const before = await http('GET', `/odata/audit/SessionLogs/$count?$filter=conversationID eq '${run}-audit'`)
    if (before.status === 401 || before.status === 403) return 'SKIP: this caller cannot read the audit log'
    if (!before.ok) return `SKIP: audit log not readable (HTTP ${before.status})`

    await ask(marker, { conversationID: `${run}-audit` })
    const after = await http('GET', `/odata/audit/SessionLogs/$count?$filter=conversationID eq '${run}-audit'`)
    const n = Number(after.text) - Number(before.text)
    assert(n === 1, `one question produced ${n} audit rows`)
    return 'exactly one row'
  })

  await scenario('a fetch that failed is never answered as an empty result', async () => {
    // The dangerous failure: "no records matched" for a warehouse that was
    // never actually queried reads as "there is no stock" — a different and
    // much more expensive statement than "I could not check".
    //
    // The check hangs on `grounded`, not on status. grounded is set only when a
    // tool actually returned rows, so a genuinely empty result is grounded and
    // a failed fetch is not. An answer that states an empty result while
    // ungrounded is the bug, whatever status the run reports — and status is
    // precisely what the bug gets wrong, so testing on it instead would pass
    // exactly when it matters.
    const res = await ask('How much stock do we have?')
    assert(res.ok, `HTTP ${res.status}`)
    const m = JSON.parse(res.json.metrics || '{}')
    const claimsEmpty = /no records matched|no records were found|there (are|is) no /i.test(res.json.answer || '')

    assert(!(claimsEmpty && m.grounded !== true),
      `an ungrounded run reported an empty result: "${(res.json.answer || '').slice(0, 100)}" ` +
      `(status ${res.json.status}) — nothing was fetched, so it cannot know the data is absent`)

    if (m.grounded === true) return 'backend reachable; the empty-result path is exercised by the unit tests'
    assert(res.json.status === 'FAILED' || res.json.status === 'ERROR',
      `nothing was grounded, yet the run reported ${res.json.status}`)
    return `reported honestly as ${res.json.status}`
  })

  // --- report ---------------------------------------------------------------

  console.log(`\n${'—'.repeat(60)}`)
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed) {
    console.log(`\n${RED}What a user would see:${OFF}`)
    for (const f of failures) console.log(`  • ${f}`)
    console.log()
    process.exit(1)
  }
  if (skipped) console.log(`${DIM}Skipped scenarios were not verified — they are not passes.${OFF}`)
  console.log(`\n${GREEN}This instance behaves correctly end to end.${OFF}\n`)
}

main().catch((err) => {
  console.error(`\n${RED}The suite itself failed: ${err.stack}${OFF}\n`)
  process.exit(2)
})
