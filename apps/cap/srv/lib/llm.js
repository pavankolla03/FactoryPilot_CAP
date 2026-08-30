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

  async complete({ messages, tools, model, maxTokens = 800, temperature = 0.2, timeoutMs }) {
    const body = {
      model: model || this.model,
      messages,
      // Free models reason before they answer, and the reasoning is billed
      // against the same budget. Asking for exactly the answer length leaves
      // nothing to answer *with*: the log fills with `finish_reason: length`
      // and an empty message, and the run falls through to the paid key for no
      // reason other than an arithmetic mistake here.
      max_tokens: Math.max(2000, maxTokens * 3),
      temperature,
      // Reasoning models otherwise spend the token budget thinking out loud
      // and, when the budget runs out mid-thought, the deliberation lands in
      // `content` — so an operator reads "We need to provide a summary of..."
      // instead of the summary. Excluding it also stops paying for tokens
      // nobody reads.
      reasoning: { exclude: true },
    }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const controller = new AbortController()
    // The caller may have less time left than this provider's own default —
    // an agent loop running against a gateway deadline, for instance. Whoever
    // is stricter wins.
    const budget = Math.max(1000, Math.min(this.timeoutMs, timeoutMs || this.timeoutMs))
    const timer = setTimeout(() => controller.abort(), budget)
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
        err.name === 'AbortError' ? `OpenRouter timed out after ${budget}ms` : `OpenRouter request failed: ${err.message}`
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

  // A reasoning model that exhausts its budget before writing an answer
  // returns empty content and no tool calls. That is a failed completion, not
  // a silent empty answer — say so, and let the caller fall back.
  const text = choice.message?.content || ''
  const calls = choice.message?.tool_calls || []
  if (!text.trim() && !calls.length) {
    throw new LLMError(
      `${vendor} returned an empty answer` +
        (choice.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '') +
        '. The model likely ran out of tokens before answering.'
    )
  }

  return {
    text,
    toolCalls: calls.map((tc) => ({
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

  async complete({ messages, tools, maxTokens = 800, temperature = 0.2, timeoutMs }) {
    const body = { messages, max_tokens: maxTokens, temperature }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    // Retry once on 401: a token cached across a rotation is still within its
    // stated expiry but no longer accepted.
    let res = await this.#post(body, await oauth.getToken(this.tokenEndpoint), timeoutMs)
    if (res.status === 401) {
      res = await this.#post(body, await oauth.getToken(this.tokenEndpoint, { force: true }), timeoutMs)
    }

    if (!res.ok) throw new LLMError(`AI Core returned ${res.status}: ${(await res.text()).slice(0, 300)}`)

    return parseCompletion(await res.json(), {
      provider: this.name,
      model: this.deploymentId,
      vendor: 'AI Core',
    })
  }

  async #post(body, token, timeoutMs) {
    const controller = new AbortController()
    // The caller may have less time left than this provider's own default —
    // an agent loop running against a gateway deadline, for instance. Whoever
    // is stricter wins.
    const budget = Math.max(1000, Math.min(this.timeoutMs, timeoutMs || this.timeoutMs))
    const timer = setTimeout(() => controller.abort(), budget)
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
        err.name === 'AbortError' ? `AI Core timed out after ${budget}ms` : `AI Core request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * OpenAI chat-completions.
 *
 * Kept separate from OpenRouter rather than parameterised, because the GPT-5
 * family rejects two things the OpenAI-compatible shape normally accepts, and
 * both are hard errors rather than warnings:
 *   - `max_tokens` is refused; it wants `max_completion_tokens`
 *   - `temperature` may only be the default, so it is not sent at all
 *
 * These models also spend reasoning tokens out of the same completion budget —
 * a 300-token budget was 128 tokens of thinking and very little answer — so
 * the budget is widened before it is sent.
 */
class OpenAIProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model, timeoutMs = 60000 }) {
    if (!apiKey) throw new LLMError('OPENAI_API_KEY is not set')
    Object.assign(this, { apiKey, baseUrl: baseUrl.replace(/\/$/, ''), model, timeoutMs })
    this.name = 'openai'
  }

  async complete({ messages, tools, model, maxTokens = 800, timeoutMs }) {
    const body = {
      model: model || this.model,
      messages,
      // Reasoning is billed and budgeted here, so asking for exactly the
      // answer length leaves nothing to answer with: at 1600 the model spent
      // the lot thinking and returned finish_reason "length" with no text.
      max_completion_tokens: Math.max(2500, maxTokens * 3),
      // "low" was measured at ~256 reasoning tokens and still produced a
      // markdown table; "minimal" is cheaper but drops to bullet lists, and
      // the default overruns the budget on a 25-row tool result.
      reasoning_effort: process.env.OPENAI_REASONING_EFFORT || 'low',
    }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const controller = new AbortController()
    // The caller may have less time left than this provider's own default —
    // an agent loop running against a gateway deadline, for instance. Whoever
    // is stricter wins.
    const budget = Math.max(1000, Math.min(this.timeoutMs, timeoutMs || this.timeoutMs))
    const timer = setTimeout(() => controller.abort(), budget)
    let res
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw new LLMError(
        err.name === 'AbortError' ? `OpenAI timed out after ${budget}ms` : `OpenAI request failed: ${err.message}`
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw new LLMError(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return parseCompletion(await res.json(), { provider: this.name, model: body.model, vendor: 'OpenAI' })
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
/** Greetings, thanks and other conversational openers — matched whole, so
 *  "hi" is small talk but "hi, how much stock of HI100" is not. */
const SMALL_TALK = /^(hi|hey|hello|yo|good (morning|afternoon|evening)|thanks|thank you|ok(ay)?|cheers|bye|who are you|what can you do)( there| otto| again)?[\s!.?]*$/i

class FakeProvider {
  /**
   * `role` distinguishes the two jobs this provider does, which want opposite
   * behaviour.
   *
   * 'offline' is a deliberate choice — no key configured, or demo mode — and
   * keyword tool-picking is the point: the product is demonstrable without a
   * model.
   *
   * 'fallback' is a model that was supposed to answer and could not. Guessing
   * an intent from keywords there produces confident nonsense: "what is your
   * name" matched nothing and came back "I could not match that question to a
   * registered business object", and anything brushing a keyword came back
   * "0 records". Neither is an answer, and both look like the product is
   * broken rather than the model being unavailable.
   */
  constructor(role = 'offline') {
    this.name = 'fake'
    this.model = 'fake/deterministic-v1'
    this.role = role
  }

  async complete({ messages, tools, maxTokens = 800 }) {
    // Scope everything to the current turn. Looking at the whole conversation
    // makes a tool result from an *earlier* question count as "already
    // answered", so the second question in a conversation never calls a tool
    // and silently re-summarises stale data.
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
    const turn = lastUserIdx === -1 ? messages : messages.slice(lastUserIdx)

    const asked = messages[lastUserIdx]?.content || ''
    const question = asked.toLowerCase()
    const alreadyCalled = turn.some((m) => m.role === 'tool')

    const promptTokens = Math.ceil(messages.reduce((n, m) => n + (m.content?.length || 0), 0) / 4)

    // "hi" is not a query. Sending it hunting for a business object produces
    // "I could not match that question to a registered business object",
    // which reads as a malfunction rather than a greeting.
    // Standing in for a model that failed: say so. Do not invent an intent.
    if (this.role === 'fallback' && !alreadyCalled) {
      const reply =
        'The language model is unavailable right now, so I cannot interpret that question. ' +
        'Your data and permissions are fine — please try again shortly.'
      return {
        text: reply,
        toolCalls: [],
        provider: this.name,
        model: this.model,
        promptTokens,
        completionTokens: Math.ceil(reply.length / 4),
        totalTokens: promptTokens + Math.ceil(reply.length / 4),
        isEstimated: true,
      }
    }

    if (!alreadyCalled && SMALL_TALK.test(question.trim())) {
      const reply =
        'Hello. Ask me about stock, goods movements, physical inventory counts, ' +
        'deliveries or purchase orders — or tell me to move stock and I will prepare it for your approval.'
      return {
        text: reply,
        toolCalls: [],
        provider: this.name,
        model: this.model,
        promptTokens,
        completionTokens: Math.ceil(reply.length / 4),
        totalTokens: promptTokens + Math.ceil(reply.length / 4),
        isEstimated: true,
      }
    }

    if (!alreadyCalled && tools?.length) {
      const picked = pickTool(question, tools)
      if (picked) {
        const args = inferArgs(question, picked, asked)

        // A write whose required values were not stated is not proposed. The
        // card a human approves must carry only what they actually said —
        // filling a blank with a plausible material number or a quantity of 1
        // is how an unnoticed goods movement gets approved.
        const missing = missingRequired(picked, args)
        if (missing.length) {
          const need = missing
            .map((k) => ({ materialID: 'which material', quantity: 'how many', warehouseID: 'which plant' }[k] || k))
            .join(', ')
          const reply = `I can prepare that, but I need ${need} before I can put it in front of you to approve.`
          return {
            text: reply,
            toolCalls: [],
            provider: this.name,
            model: this.model,
            promptTokens,
            completionTokens: Math.ceil(reply.length / 4),
            totalTokens: promptTokens + Math.ceil(reply.length / 4),
            isEstimated: true,
          }
        }

        return {
          text: '',
          toolCalls: [{ id: `call_${picked.function.name}`, name: picked.function.name, arguments: args }],
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

/**
 * `question` is lowercased for keyword matching; `original` is what the user
 * actually typed. Material numbers are case-sensitive in S/4, so extracting
 * them from the lowercased copy produced "p123", which matches no row.
 */
function inferArgs(question, tool, original = question) {
  const args = {}
  const props = tool.function?.parameters?.properties || {}

  if ('warehouseID' in props) {
    // Only when the question actually names one. Defaulting to a literal
    // plant overrides the configured default warehouse, so a tenant whose
    // plants are 1010 and 1710 had every question silently asked against a
    // plant that does not exist — and answered "no records matched".
    const named = question.match(/\b(\d{4})\b/)?.[1]
    if (named) args.warehouseID = named
  }

  if ('datePreset' in props) {
    args.datePreset = /yesterday/.test(question) ? 'yesterday' : /tomorrow/.test(question) ? 'tomorrow' : 'today'
  }

  // A quantity must be stated, and stated as a quantity. The old pattern took
  // the first integer anywhere in the sentence, so "move stock of P123 from
  // plant 1010 to 1710" proposed moving 1010 units — the plant number read as
  // an amount — and a sentence with no number at all proposed moving 1. Both
  // reached a human as a confirmation card carrying a figure they never said.
  if ('quantity' in props) {
    const stated =
      question.match(/\b(\d+(?:\.\d+)?)\s*(?:units?|pcs|pieces|ea\b|kg\b|litres?|l\b)/i)?.[1] ||
      question.match(/\bmove\s+(\d+(?:\.\d+)?)\b/i)?.[1] ||
      question.match(/\btransfer\s+(\d+(?:\.\d+)?)\b/i)?.[1]
    if (stated) args.quantity = Number(stated)
  }

  if ('materialID' in props) {
    const found = original.match(/\b([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\b/)?.[1]
    // Never invent one. This previously fell back to the literal 'P123' for
    // the write tool, so "move 50 units from 0001 to 0002" produced an
    // approval card naming a specific material the operator had not mentioned
    // — and approving it would have posted a goods movement against it.
    if (found && /\d/.test(found)) args.materialID = found
  }

  return args
}

/**
 * Which required arguments a proposed call is missing.
 *
 * A write that cannot be fully described must not be proposed at all: a
 * confirmation card is only meaningful if every value on it came from the
 * person who will approve it.
 */
function missingRequired(tool, args) {
  const required = tool.function?.parameters?.required || []
  return required.filter((k) => args[k] === undefined || args[k] === '' || args[k] === null)
}


function summarise(raw) {
  const parsed = safeParse(raw)
  // A failed fetch is not an empty result. Saying "no records" when the
  // source system was never reached tells a supervisor there is no stock,
  // which is a different and much more expensive statement than "I could
  // not check".
  if (parsed?.error) return `I could not reach the source system, so I have no data to answer that: ${parsed.error}`
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : Array.isArray(parsed) ? parsed : []

  if (!rows.length) {
    // Say what was asked. "No records matched … for the requested period and
    // location" asserts a period and a location that may never have been part
    // of the query, so a plant with no stock and a plant that was never
    // queried read identically.
    return parsed?.queriedWith && parsed.queriedWith !== '(no filter)'
      ? `No records matched. The query sent to SAP was: ${parsed.queriedWith}.`
      : 'No records matched that question.'
  }

  // The rows here are a sample — agent.js caps what it sends the model — so
  // every figure computed from them is a sample statistic. Reporting one as a
  // population total is the difference between "2,500 units on hand" and the
  // truth of roughly eight times that. rowCount and truncated were put in the
  // payload for exactly this and were not being read.
  const total = Number(parsed?.rowCount)
  const sampled = parsed?.truncated === true && Number.isFinite(total) && total > rows.length
  const caveat = sampled
    ? ` These figures cover ${rows.length} of ${total} matching records — a sample, not the full total.`
    : ''

  const counts = {}
  // Shape-detect the object rather than counting a status field that only
  // deliveries have — every other object was reporting "N unknown", which is a
  // true statement that answers nothing.
  const shaped = summariseByShape(rows)
  if (shaped) return shaped + caveat

  for (const row of rows) {
    const key = String(row.OverallGoodsMovementStatus ?? row.status ?? 'unknown')
    counts[key] = (counts[key] || 0) + 1
  }
  const labels = { A: 'not started', B: 'partially processed', C: 'completed' }
  const parts = Object.entries(counts)
    .sort()
    .map(([code, n]) => `${n} ${labels[code] || code}`)
    .join(', ')
  return sampled
    ? `${total} record(s) match that question. Of the ${rows.length} examined, the breakdown by status is: ${parts}.`
    : `You have ${rows.length} record(s) matching that question. Breakdown by status: ${parts}.`
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const sum = (rows, field) => rows.reduce((n, r) => n + num(r[field]), 0)
const round = (n) => Math.round(n * 100) / 100

/** Tally a field into "3 A, 2 B" ordered by frequency. */
function tally(rows, pick) {
  const counts = {}
  for (const r of rows) {
    const k = pick(r)
    if (k) counts[k] = (counts[k] || 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

/**
 * A readable sentence per S/4 object, chosen by the fields present.
 *
 * These are the same numbers a real model would be asked to summarise, so the
 * offline provider stays a faithful stand-in rather than a placeholder — the
 * product is demonstrable with no API key at all.
 */
function summariseByShape(rows) {
  const r0 = rows[0] || {}

  if ('MatlWrhsStkQtyInMatlBaseUnit' in r0) {
    // A_MatlStkInAcctMod carries one quantity per row; what kind of stock it is
    // comes from InventoryStockType, not from separate columns. Verified
    // against the live Hub — the split columns this once read do not exist.
    const STOCK_TYPE = { '01': 'unrestricted', '02': 'quality inspection', '03': 'blocked', '04': 'blocked' }
    const held = rows.filter((r) => num(r.MatlWrhsStkQtyInMatlBaseUnit) > 0)
    const total = sum(rows, 'MatlWrhsStkQtyInMatlBaseUnit')
    const materials = new Set(rows.map((r) => r.Material).filter(Boolean)).size
    const plants = new Set(rows.map((r) => r.Plant).filter(Boolean)).size

    const byType = {}
    for (const r of rows) {
      const label = STOCK_TYPE[r.InventoryStockType] || 'unclassified'
      byType[label] = (byType[label] || 0) + num(r.MatlWrhsStkQtyInMatlBaseUnit)
    }
    const split = Object.entries(byType)
      .filter(([, q]) => q > 0)
      .map(([label, q]) => `${round(q)} ${label}`)
      .join(', ')

    const top = [...rows].sort(
      (a, b) => num(b.MatlWrhsStkQtyInMatlBaseUnit) - num(a.MatlWrhsStkQtyInMatlBaseUnit)
    )[0]

    if (!held.length) {
      return `${rows.length} stock record(s) across ${materials} material(s) in ${plants} plant(s), but every one is at zero quantity.`
    }
    return (
      `${round(total)} units on hand across ${materials} material(s) in ${plants} plant(s)` +
      `${split ? ` — ${split}` : ''}. ` +
      `Largest single holding: ${top.Material || '(unnamed)'} at ` +
      `${round(num(top.MatlWrhsStkQtyInMatlBaseUnit))} ${top.MaterialBaseUnit || ''} in plant ${top.Plant}` +
      `${top.StorageLocation ? `, location ${top.StorageLocation}` : ''}.`
    )
  }

  if ('GoodsMovementType' in r0) {
    const labels = { 101: 'goods receipts', 261: 'issues to order', 311: 'transfers', 601: 'deliveries' }
    const reversed = rows.filter((r) => r.ReversedMaterialDocument).length
    const parts = tally(rows, (r) => r.GoodsMovementType)
      .map(([code, n]) => `${n} ${labels[code] || `type ${code}`}`)
      .join(', ')
    return (
      `${rows.length} goods movement(s): ${parts}.` +
      (reversed ? ` ${reversed} of them were reversed and should be excluded from any net figure.` : '')
    )
  }

  if ('PhysicalInventoryDocument' in r0) {
    // Real field names: PhysicalInventoryCountStatus and
    // PhysInvtryAdjustmentPostingSts. Both are single-character codes where
    // 'X' or 'A' mean done; anything else means outstanding.
    const done = (v) => v === 'X' || v === 'A' || v === true || v === 'true'
    const counted = rows.filter((r) => done(r.PhysicalInventoryCountStatus)).length
    const posted = rows.filter((r) => done(r.PhysInvtryAdjustmentPostingSts)).length
    const open = rows.length - counted
    const plants = new Set(rows.map((r) => r.Plant).filter(Boolean)).size
    return (
      `${rows.length} physical inventory document(s) across ${plants} plant(s): ${open} still to count, ` +
      `${counted} counted, ${posted} posted. ` +
      `${open ? `The ${open} uncounted document(s) are what block period close.` : 'Nothing is outstanding.'}`
    )
  }

  if ('PurchaseOrder' in r0) {
    // No net amount on the header — that lives on the items. Reporting a
    // total here would mean summing a column that does not exist, which OData
    // answers with nothing rather than an error.
    const deleted = rows.filter((r) => r.PurchasingDocumentDeletionCode).length
    const live = rows.filter((r) => !r.PurchasingDocumentDeletionCode)
    const open = live.filter((r) => !r.PurchasingCompletenessStatus)
    const bySupplier = tally(open, (r) => r.SupplierName || r.Supplier)
    const orgs = new Set(live.map((r) => r.PurchasingOrganization).filter(Boolean)).size
    return (
      `${open.length} of ${live.length} purchase order(s) are still open` +
      `${orgs ? ` across ${orgs} purchasing organisation(s)` : ''}.` +
      `${bySupplier.length ? ` Most are with supplier ${bySupplier[0][0]} (${bySupplier[0][1]}).` : ''}` +
      (deleted ? ` ${deleted} deleted order(s) were excluded.` : '')
    )
  }

  return null
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
  const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY)

  if (explicit === 'openai' || (!explicit && route.provider === 'openai' && hasOpenAIKey)) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: route.model || process.env.OPENAI_MODEL || 'gpt-5-nano',
    })
  }

  if (!explicit && route.provider === 'openai' && !hasOpenAIKey) {
    warnOnce('[llm] ModelRoute asks for openai but OPENAI_API_KEY is unset — using the offline provider.')
  }
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
      model: route.model || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
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

/**
 * The free OpenRouter model used when nothing names one.
 *
 * Free and tool-capable are both hard requirements: the whole architecture is a
 * tool-calling loop, and a model that cannot call a tool answers warehouse
 * questions from nothing. Verified against OpenRouter's own model list rather
 * than picked from memory.
 */
const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free'

/**
 * Every provider worth trying for one request, best first.
 *
 * A single provider is a single point of failure, and a *free* provider is the
 * most likely one to fail — free quota runs out partway through a day, and it
 * runs out mid-demo. So OpenRouter leads and the paid key catches the overflow
 * automatically, rather than the run collapsing to the offline provider the
 * moment a free tier says no.
 *
 * LLM_PROVIDER still pins whichever rung an operator names, but pinning one
 * does not remove the rest: a pinned provider that fails still falls through.
 * The offline provider is always last and always present, so there is no
 * configuration in which a question gets no answer at all.
 */
function getProviderChain(route = {}) {
  const pinned = process.env.LLM_PROVIDER || route.provider || ''
  const chain = []
  const seen = new Set()
  // Keyed by provider *and* model: OpenRouter contributes several rungs, one
  // per free model, and deduping on the provider name alone would collapse
  // them into one.
  const add = (provider) => {
    if (!provider) return
    const key = `${provider.name}:${provider.model || ''}`
    if (seen.has(key)) return
    seen.add(key)
    chain.push(provider)
  }

  const build = {
    // One rung per free model, primary then the route's fallbacks. A model
    // that is rate-limited should cost the next *free* model, not the paid
    // key — the point of leading with the free tier is to stay on it.
    openrouter: () => {
      if (!process.env.OPENROUTER_API_KEY) return []
      // route.model only means something to the provider it was written for.
      // Handing `nvidia/nemotron...` to OpenAI, or `gpt-5-nano` to OpenRouter,
      // is a 400 on the rung that was supposed to be the safety net.
      const mine = pinned === 'openrouter' || route.provider === 'openrouter'
      const primary = (mine && route.model) || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
      const alternates = mine ? String(route.fallbacks || '').split(',') : []
      return [primary, ...alternates]
        .map((m) => String(m).trim())
        .filter(Boolean)
        .map((model) => new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY, model }))
    },
    openai: () =>
      process.env.OPENAI_API_KEY &&
      new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        model:
          pinned === 'openai' || route.provider === 'openai'
            ? route.model || process.env.OPENAI_MODEL || 'gpt-5-nano'
            : process.env.OPENAI_MODEL || 'gpt-5-nano',
      }),
    aicore: () =>
      process.env.AICORE_BASE_URL &&
      process.env.AICORE_DEPLOYMENT_ID &&
      process.env.AICORE_TOKEN_URL &&
      new AICoreProvider({
        baseUrl: process.env.AICORE_BASE_URL,
        deploymentId: route.model || process.env.AICORE_DEPLOYMENT_ID,
        tokenUrl: process.env.AICORE_TOKEN_URL,
        resourceGroup: process.env.AICORE_RESOURCE_GROUP || 'default',
      }),
  }

  // Free first, then paid, then the customer's own tenant — cheapest capable
  // rung leads. A pinned provider is promoted to the front of that order.
  const order = ['openrouter', 'openai', 'aicore']
  for (const name of [pinned, ...order]) {
    if (!build[name]) continue
    try {
      const built = build[name]()
      for (const provider of Array.isArray(built) ? built : [built]) add(provider)
    } catch {
      // A provider that refuses to construct (no key, half-set config) is
      // simply not a rung. The next one is tried.
    }
  }

  // Two different jobs, two different roles. With nothing else configured the
  // app is genuinely offline, and the offline provider's keyword matching *is*
  // the demo — it computes real answers from real tool output. Standing in for
  // a model that failed is the opposite situation: the intent is unknown, and
  // guessing it is how "what is your name" once got answered with an inventory
  // count. Then it must say the model is unavailable instead.
  add(new FakeProvider(chain.length ? 'fallback' : 'offline'))
  return chain
}

/** Once per process, not once per request — this is config, and it does not
 *  change between two questions asked a second apart. */
const warned = new Set()
function warnOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

module.exports = {
  LLMError, OpenRouterProvider, OpenAIProvider, AICoreProvider, FakeProvider,
  getProvider, getProviderChain, DEFAULT_OPENROUTER_MODEL, safeParse,
}
