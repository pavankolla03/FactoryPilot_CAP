/**
 * LLM providers behind one `complete()` contract (ADR-019).
 *
 * Only this module knows a vendor exists. The agent loop asks for a completion
 * and gets back text, tool calls and a token count — nothing provider-shaped.
 */

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

    const payload = await res.json()
    const choice = payload.choices?.[0]
    if (!choice) throw new LLMError('OpenRouter returned no choices')
    const usage = payload.usage || {}

    return {
      text: choice.message?.content || '',
      toolCalls: (choice.message?.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: safeParse(tc.function?.arguments),
      })),
      provider: this.name,
      model: payload.model || body.model,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      isEstimated: usage.total_tokens == null,
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
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const question = (lastUser?.content || '').toLowerCase()
    const alreadyCalled = messages.some((m) => m.role === 'tool')

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

    const toolOutput = [...messages].reverse().find((m) => m.role === 'tool')
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

  if (explicit === 'openrouter' || (!explicit && route.provider === 'openrouter' && hasOpenRouterKey)) {
    return new OpenRouterProvider({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: route.model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
    })
  }

  if (!explicit && route.provider === 'openrouter' && !hasOpenRouterKey) {
    // Say it once per process rather than per request.
    if (!getProvider._warned) {
      console.warn(
        '[llm] ModelRoute asks for openrouter but OPENROUTER_API_KEY is unset — using the offline provider. ' +
          'Answers are computed from real tool output, but no model is called.'
      )
      getProvider._warned = true
    }
  }

  return new FakeProvider()
}

module.exports = { LLMError, OpenRouterProvider, FakeProvider, getProvider, safeParse }
