const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const llm = require('../srv/lib/llm')

/**
 * Provider selection, which is pure configuration and worth testing on its own.
 *
 * Everything here is about which rung gets tried and in what order — never
 * about what a model says. The rules encoded below each exist because getting
 * them wrong costs money or costs the demo: a paid model reached by a typo, a
 * second API key that silently never gets used, a third-party vendor selected
 * for a client who was promised it would not be.
 */

// Every key this module reads, so a test cannot inherit the developer's own.
const OWNED = [
  'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3', 'OPENROUTER_API_KEYS',
  'OPENROUTER_MODEL', 'OPENROUTER_ALLOW_PAID', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'LLM_PROVIDER', 'AICORE_BASE_URL', 'AICORE_DEPLOYMENT_ID', 'AICORE_TOKEN_URL',
]

let saved
beforeEach(() => {
  saved = Object.fromEntries(OWNED.map((k) => [k, process.env[k]]))
  for (const k of OWNED) delete process.env[k]
  llm._resetKeyCooldowns()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  llm._resetKeyCooldowns()
})

/** The chain as `provider:model:key` strings — what the assertions read best. */
const chainOf = (route) =>
  llm.getProviderChain(route || {}).map((p) => `${p.name}:${p.model || ''}:${p.keyLabel || ''}`)

const KEY1 = 'sk-or-v1-aaaaaaaaaaaaKEY1'
const KEY2 = 'sk-or-v1-bbbbbbbbbbbbKEY2'
const FREE = llm.DEFAULT_OPENROUTER_MODEL

describe('a second OpenRouter key is a second day of free quota', () => {
  test('both keys become rungs, not just the first', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_API_KEY_2 = KEY2
    assert.deepEqual(chainOf(), [
      `openrouter:${FREE}:…KEY1`,
      `openrouter:${FREE}:…KEY2`,
      'fake:fake/deterministic-v1:',
    ])
  })

  test('keys may also be listed together in OPENROUTER_API_KEYS', () => {
    process.env.OPENROUTER_API_KEYS = `${KEY1}, ${KEY2}`
    const chain = chainOf()
    assert.ok(chain.includes(`openrouter:${FREE}:…KEY1`))
    assert.ok(chain.includes(`openrouter:${FREE}:…KEY2`))
  })

  test('the rung after a failure is a different key, not the next model', () => {
    // Model-major. Key-major would spend one dead call per model before
    // discovering the key — not the model — was the thing that was exhausted.
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_API_KEY_2 = KEY2
    assert.deepEqual(chainOf({ provider: 'openrouter', model: 'a/one:free', fallbacks: 'b/two:free' }), [
      'openrouter:a/one:free:…KEY1',
      'openrouter:a/one:free:…KEY2',
      'openrouter:b/two:free:…KEY1',
      'openrouter:b/two:free:…KEY2',
      'fake:fake/deterministic-v1:',
    ])
  })

  test('a key that has hit its quota is skipped until it resets', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_API_KEY_2 = KEY2
    llm.markKeyExhausted(KEY1)
    assert.deepEqual(chainOf(), [`openrouter:${FREE}:…KEY2`, 'fake:fake/deterministic-v1:'])
  })

  test('when every key is cooling they are all tried anyway', () => {
    // A cooldown is inferred from one response. A wrong inference must never
    // be able to take the product offline for the rest of the day.
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_API_KEY_2 = KEY2
    llm.markKeyExhausted(KEY1)
    llm.markKeyExhausted(KEY2)
    const chain = chainOf()
    assert.ok(chain.includes(`openrouter:${FREE}:…KEY1`))
    assert.ok(chain.includes(`openrouter:${FREE}:…KEY2`))
  })
})

describe('only free models are ever requested', () => {
  test('a model without the :free suffix is refused and the default stands in', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o'
    assert.deepEqual(chainOf(), [`openrouter:${FREE}:…KEY1`, 'fake:fake/deterministic-v1:'])
  })

  test('a paid model in a route fallback list is dropped, the free ones kept', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    assert.deepEqual(
      chainOf({ provider: 'openrouter', model: 'a/one:free', fallbacks: 'b/paid,c/three:free' }),
      ['openrouter:a/one:free:…KEY1', 'openrouter:c/three:free:…KEY1', 'fake:fake/deterministic-v1:']
    )
  })

  test('OPENROUTER_ALLOW_PAID is the deliberate way out', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENROUTER_ALLOW_PAID = '1'
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o'
    assert.deepEqual(chainOf(), ['openrouter:openai/gpt-4o:…KEY1', 'fake:fake/deterministic-v1:'])
  })
})

describe('no third-party vendor is selected on its own', () => {
  test('an OpenAI key lying around does not put OpenAI in the chain', () => {
    // The product runs on OpenRouter free plus the client's own AI Core. A
    // stray key in the environment must not quietly start billing, and must
    // not send a client's operational questions somewhere they did not agree.
    process.env.OPENROUTER_API_KEY = KEY1
    process.env.OPENAI_API_KEY = 'sk-openai-must-not-be-used'
    assert.ok(!chainOf().some((r) => r.startsWith('openai:')))
  })

  test('but an operator can still pin it explicitly', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-deliberate'
    process.env.LLM_PROVIDER = 'openai'
    assert.ok(chainOf().some((r) => r.startsWith('openai:')))
  })

  test('AI Core is selected when its tenant config is complete', () => {
    process.env.AICORE_BASE_URL = 'https://api.ai.example/v2'
    process.env.AICORE_DEPLOYMENT_ID = 'd-123'
    process.env.AICORE_TOKEN_URL = 'https://auth.example/oauth/token'
    assert.ok(chainOf().some((r) => r.startsWith('aicore:')))
  })

  test('half-configured AI Core is not a rung', () => {
    process.env.AICORE_BASE_URL = 'https://api.ai.example/v2'
    assert.ok(!chainOf().some((r) => r.startsWith('aicore:')))
  })
})

describe('there is always an answer', () => {
  test('with nothing configured the offline provider carries the demo', () => {
    const chain = llm.getProviderChain({})
    assert.equal(chain.length, 1)
    assert.equal(chain[0].role, 'offline')
  })

  test('with a real provider present the last rung refuses to guess instead', () => {
    process.env.OPENROUTER_API_KEY = KEY1
    const chain = llm.getProviderChain({})
    assert.equal(chain.at(-1).role, 'fallback')
  })
})
