/**
 * LLM providers behind one `complete()` contract (ADR-019).
 *
 * Only this module knows a vendor exists. The agent loop asks for a completion
 * and gets back text, tool calls and a token count — nothing provider-shaped.
 */

const oauth = require('./oauth')

class LLMError extends Error {}

/** OpenRouter chat-completions with tool calling. */
class OpenRouterProvider {
  constructor({ apiKey, baseUrl = 'https://openrouter.ai/api/v1', model, timeoutMs = 30000 }) {
    if (!apiKey) throw new LLMError('OPENROUTER_API_KEY is not set')
    Object.assign(this, { apiKey, baseUrl: baseUrl.replace(/\/$/, ''), model, timeoutMs })
    this.name = 'openrouter'
  }

  async complete({ messages, tools, model, maxTokens = 800, temperature = 0.2 }) {
    const body = {
      model: model || this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'FactoryPilot',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw new LLMError(
        err.name === 'AbortError' ? `OpenRouter timed out after ${this.timeoutMs}ms` : `OpenRouter request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw new LLMError(`OpenRouter returned ${res.status}: ${(await res.text()).slice(0, 300)}`)

    return parseCompletion(await res.json(), { provider: this.name, model: body.model, vendor: 'OpenRouter' })
  }
}

/**
 * Read a chat-completions response into the shape the agent loop expects.
 *
 * Shared because AI Core fronts OpenAI-compatible models and returns the same
 * envelope — only the transport and auth differ.
 */
function parseCompletion(payload, { provider, model, vendor }) {
  const choice = payload.choices?.[0]
  if (!choice) throw new LLMError(`${vendor} returned no choices`)
  const usage = payload.usage || {}

  return {
    text: choice.message?.content || '',
    toolCalls: (choice.message?.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeParse(tc.function?.arguments),
    })),
    provider,
    model: payload.model || model,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    isEstimated: usage.total_tokens == null,
  }
}

/**
 * SAP AI Core inference (ADR-019).
 *
 * Why this exists: OpenRouter sends the client's operational questions to a
 * third party. A client who will not accept that can run the same product
 * against a model deployed in their own AI Core tenant, and nothing above this
 * module changes.
 *
 * Three things differ from a plain OpenAI call and each one is a hard failure
 * if missed: the bearer token comes from the tenant's XSUAA (client
 * credentials, cached by oauth.js), the path is scoped to a deployment ID
 * rather than a model name, and every request must carry AI-Resource-Group —
 * without it AI Core answers 400 with a message that does not mention the
 * header.
 */
class AICoreProvider {
  constructor({ baseUrl, deploymentId, tokenUrl, resourceGroup = 'default', apiVersion = '2023-05-15', timeoutMs = 30000 }) {
    const missing = [
      !baseUrl && 'AICORE_BASE_URL',
      !deploymentId && 'AICORE_DEPLOYMENT_ID',
      !tokenUrl && 'AICORE_TOKEN_URL',
    ].filter(Boolean)
    if (missing.length) throw new LLMError(`AI Core is not configured: ${missing.join(', ')} not set`)

    Object.assign(this, {
      baseUrl: baseUrl.replace(/\/$/, ''),
      deploymentId,
      resourceGroup,
      apiVersion,
      timeoutMs,
    })
    this.name = 'aicore'
    // oauth.js keys its token cache by ID and reads the client id/secret from
    // AICORE_CLIENT_ID / AICORE_CLIENT_SECRET, same as every other endpoint —
    // the value never appears in configuration.
    this.tokenEndpoint = {
      ID: `aicore:${deploymentId}`,
      tokenUrl: tokenUrl.replace(/\/$/, '').endsWith('/oauth/token') ? tokenUrl : `${tokenUrl.replace(/\/$/, '')}/oauth/token`,
      credentialRef: 'AICORE',
      timeoutMs,
    }
  }

  get url() {
    return `${this.baseUrl}/v2/inference/deployments/${this.deploymentId}/chat/completions?api-version=${this.apiVersion}`
  }

  async complete({ messages, tools, maxTokens = 800, temperature = 0.2 }) {
    const body = { messages, max_tokens: maxTokens, temperature }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    // Retry once on 401: a token cached across a rotation is still within its
    // stated expiry but no longer accepted.
    let res = await this.#post(body, await oauth.getToken(this.tokenEndpoint))
    if (res.status === 401) {
      res = await this.#post(body, await oauth.getToken(this.tokenEndpoint, { force: true }))
    }

    if (!res.ok) throw new LLMError(`AI Core returned ${res.status}: ${(await res.text()).slice(0, 300)}`)

    return parseCompletion(await res.json(), {
      provider: this.name,
      model: this.deploymentId,
      vendor: 'AI Core',
    })
  }

  async #post(body, token) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'AI-Resource-Group': this.resourceGroup,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw new LLMError(
        err.name === 'AbortError' ? `AI Core timed out after ${this.timeoutMs}ms` : `AI Core request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Deterministic offline provider.
 *
 * Not a canned-response stub: it reads the registered tool list, picks the tool
 * whose keywords match the question, asks for it on the first round, then
 * summarises whatever that tool actually returned. The loop, the confirm flow
 * and token accounting all run for real without an API key.
 */
class FakeProvider {
  constructor() {
    this.name = 'fake'
    this.model = 'fake/deterministic-v1'
  }

  async complete({ messages, tools, maxTokens = 800 }) {
    // Scope everything to the current turn. Looking at the whole conversation
    // makes a tool result from an *earlier* question count as "already
    // answered", so the second question in a conversation never calls a tool
    // and silently re-summarises stale data.
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
    const turn = lastUserIdx === -1 ? messages : messages.slice(lastUserIdx)

    const question = (messages[lastUserIdx]?.content || '').toLowerCase()
    const alreadyCalled = turn.some((m) => m.role === 'tool')

    const promptTokens = Math.ceil(messages.reduce((n, m) => n + (m.content?.length || 0), 0) / 4)

    if (!alreadyCalled && tools?.length) {
      const picked = pickTool(question, tools)
      if (picked) {
        return {
          text: '',
          toolCalls: [{ id: `call_${picked.function.name}`, name: picked.function.name, arguments: inferArgs(question, picked) }],
          provider: this.name,
          model: this.model,
          promptTokens,
          completionTokens: 8,
          totalTokens: promptTokens + 8,
          isEstimated: true,
        }
      }
    }

    // Summarise only what this turn's tool returned, never an older one.
    const toolOutput = [...turn].reverse().find((m) => m.role === 'tool')
    const text = toolOutput ? summarise(toolOutput.content) : "I could not match that question to a registered business object."
    const completionTokens = Math.ceil(text.length / 4)

    return {
      text,
      toolCalls: [],
      provider: this.name,
      model: this.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      isEstimated: true,
    }
  }
}

/**
 * Stand-in for a real model's tool choice: longest keyword wins, but a keyword
 * the question *opens* with wins outright.
 *
 * Without the position bonus "Move 250 units to shipping" matches DELIVERY on
 * "shipping" — the longer keyword — and the write never reaches the approval
 * path at all. A real model reads the imperative; this approximates that.
 */
function pickTool(question, tools) {
  let best = null
  for (const tool of tools) {
    const keywords = (tool.function?.description || '').toLowerCase().match(/keywords:\s*(.+)$/m)?.[1] || ''
    for (const kw of keywords.split(',').map((k) => k.trim()).filter(Boolean)) {
      if (!question.includes(kw)) continue
      const score = kw.length + (question.trimStart().startsWith(kw) ? 100 : 0)
      if (!best || score > best.score) best = { tool, score }
    }
  }
  return best?.tool || null
}

function inferArgs(question, tool) {
  const args = {}
  const props = tool.function?.parameters?.properties || {}
  if ('warehouseID' in props) {
    args.warehouseID = question.match(/\b(\d{4})\b/)?.[1] || '1000'
  }
  if ('datePreset' in props) {
    args.datePreset = /yesterday/.test(question) ? 'yesterday' : /tomorrow/.test(question) ? 'tomorrow' : 'today'
  }
  if ('quantity' in props) args.quantity = Number(question.match(/\b(\d+)\s*(units?|pcs)?\b/)?.[1] || 1)
  if ('materialID' in props) args.materialID = question.match(/\b([A-Z]\d{2,})\b/i)?.[1] || 'P123'
  return args
}

function summarise(raw) {
  const parsed = safeParse(raw)
  // A failed fetch is not an empty result. Saying "no records" when the
  // source system was never reached tells a supervisor there is no stock,
  // which is a different and much more expensive statement than "I could
  // not check".
  if (parsed?.error) return `I could not reach the source system, so I have no data to answer that: ${parsed.error}`
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : Array.isArray(parsed) ? parsed : []
  if (!rows.length) return 'No records matched that question for the requested period and location.'

  const counts = {}
  for (const row of rows) {
    const key = String(row.OverallGoodsMovementStatus ?? row.status ?? 'unknown')
    counts[key] = (counts[key] || 0) + 1
  }
  const labels = { A: 'not started', B: 'partially processed', C: 'completed' }
  const parts = Object.entries(counts)
    .sort()
    .map(([code, n]) => `${n} ${labels[code] || code}`)
    .join(', ')
  return `You have ${rows.length} record(s) matching that question. Breakdown by status: ${parts}.`
}

function safeParse(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Config-driven selection; callers never name a vendor class.
 *
 * Precedence: an explicit LLM_PROVIDER always wins, because that is an
 * operator saying what they want and a missing key there should be an error,
 * not a silent downgrade. Otherwise the configured ModelRoute is used when its
 * credential is actually present, and the offline provider covers the rest —
 * so a fresh checkout answers questions without a key, and the audit row still
 * records `fake` as the provider rather than implying a real model ran.
 */
function getProvider(route = {}) {
  const explicit = process.env.LLM_PROVIDER
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY)
  const hasAICore = Boolean(process.env.AICORE_BASE_URL && process.env.AICORE_DEPLOYMENT_ID && process.env.AICORE_TOKEN_URL)

  if (explicit === 'aicore' || (!explicit && route.provider === 'aicore' && hasAICore)) {
    return new AICoreProvider({
      baseUrl: process.env.AICORE_BASE_URL,
      deploymentId: route.model || process.env.AICORE_DEPLOYMENT_ID,
      tokenUrl: process.env.AICORE_TOKEN_URL,
      resourceGroup: process.env.AICORE_RESOURCE_GROUP || 'default',
    })
  }

  if (!explicit && route.provider === 'aicore' && !hasAICore) {
    warnOnce(
      '[llm] ModelRoute asks for aicore but AICORE_BASE_URL / AICORE_DEPLOYMENT_ID / AICORE_TOKEN_URL are not all set — ' +
        'using the offline provider. Answers are computed from real tool output, but no model is called.'
    )
  }

  if (explicit === 'openrouter' || (!explicit && route.provider === 'openrouter' && hasOpenRouterKey)) {
    return new OpenRouterProvider({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: route.model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
    })
  }

  if (!explicit && route.provider === 'openrouter' && !hasOpenRouterKey) {
    warnOnce(
      '[llm] ModelRoute asks for openrouter but OPENROUTER_API_KEY is unset — using the offline provider. ' +
        'Answers are computed from real tool output, but no model is called.'
    )
  }

  return new FakeProvider()
}

/** Once per process, not once per request — this is config, and it does not
 *  change between two questions asked a second apart. */
const warned = new Set()
function warnOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

module.exports = { LLMError, OpenRouterProvider, AICoreProvider, FakeProvider, getProvider, safeParse }
