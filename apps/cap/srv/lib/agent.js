const cds = require('@sap/cds')
const llm = require('./llm')
const tools = require('./tools')
const policy = require('./policy')

/**
 * The tool-calling loop, running inside CAP.
 *
 * Shape: ask the model, run whatever read tools it requests, feed the results
 * back, repeat until it answers or we hit the round cap. A write request ends
 * the loop immediately with a confirmation card — nothing that mutates a
 * backend runs on the model's say-so alone.
 */

const MAX_ROUNDS = 8
const PENDING_TTL_MS = 15 * 60 * 1000

function systemPrompt(businessObjects) {
  return [
    'You are Otto, a warehouse copilot for SAP S/4HANA manufacturing and warehouse operations.',
    '',
    'ANSWERING RULES — follow all of them:',
    // Reasoning models otherwise open with "We need to analyse the data
    // returned..." and the operator reads the deliberation instead of the
    // answer. Excluding reasoning at the API is not reliable once tools are in
    // play, so the instruction has to be here as well.
    '1. Reply with the answer only. Never narrate your thinking, restate the question, or describe what you are about to do.',
    '2. Open with the figure or finding. No preamble such as "Based on the data" or "We have a large dataset".',
    '3. Use the tools to fetch real data. Never invent record counts, material numbers, quantities or supplier names.',
    '4. When a tool result says `truncated: true`, the rows are a sample — quote `rowCount` as the real total and say the detail is a sample.',
    '5. If the tools return nothing, say so plainly rather than guessing.',
    '6. Prefer a short markdown table when reporting more than three figures. Keep prose to two or three sentences.',
    '',
    'Registered business objects:',
    ...businessObjects.map((b) => `- ${b.objectCode}: ${b.objectName || ''} (${b.keywords || ''})`),
  ].join('\n')
}

/**
 * Strip a reasoning preamble that leaked into the answer.
 *
 * Belt and braces: the API's reasoning-exclusion is ignored by some models
 * once tools are in play, and the system prompt is an instruction rather than
 * a guarantee. This drops leading paragraphs that are visibly deliberation —
 * conservatively, so a real answer is never truncated.
 */
const CUES = /\b(we|i|the user|let'?s|okay|first|the data(set)?|the question|the rows?|the result)\b/i
const THINKING = /\b(need|should|must|want|asks?|asked|analyz|analys|look|check|figure|think|assume|likely|maybe|probably|summaris|summariz|provide|large dataset|truncated)\b/i

/**
 * Strip a reasoning preamble that leaked into the answer.
 *
 * Belt and braces: the API's reasoning-exclusion is ignored by some models
 * once tools are in play, and the system prompt is an instruction rather than
 * a guarantee.
 *
 * A leading sentence is deliberation when it carries a cue AND contains no
 * figures. The digit test is what protects a real answer — "We have 42 open
 * purchase orders" opens exactly like a preamble and must survive, while "We
 * have a large dataset" must not.
 */
function stripDeliberation(text) {
  const original = String(text || '').trim()
  if (!original) return original

  let rest = original
  for (let i = 0; i < 6; i++) {
    // Once a table, heading or list has started, the answer has started.
    if (/^\s*[|#\-*]/.test(rest)) break
    // A sentence may end inside quotes — "We need to answer: \"how much?\"" —
    // so the terminator can be followed by a closing quote or bracket before
    // the whitespace. Missing that left every leaked preamble in place.
    const m = rest.match(/^([^.!?\n]{0,300}[.!?]+["'\u201d\u2019)\]]*)(\s+|$)/)
    if (!m) break
    const sentence = m[1]
    // The thinking cue is what identifies deliberation. A real answer that
    // opens "We have 42 open purchase orders" carries no such verb and
    // survives, which is why no digit test is needed here.
    // Either a pronoun cue plus a thinking verb ("we need to…"), or a bare
    // imperative opening ("Need to summarise…") which these models emit when
    // they drop the subject mid-stream.
    const opensWithThinking = /^\s*(need|should|must|let'?s|first|next|now)\b/i.test(sentence)
    if (!((CUES.test(sentence) && THINKING.test(sentence)) || opensWithThinking)) break
    const remainder = rest.slice(m[0].length)
    if (!remainder.trim()) break   // never strip away the whole answer
    rest = remainder
  }
  return rest.trim() || original
}


/**
 * Drop assistant turns whose tool calls never got results.
 *
 * These appear whenever a write went to the confirm flow instead of executing.
 * Most providers reject a dangling tool call outright, so a single unconfirmed
 * write would otherwise poison every later turn in that conversation.
 */
function sanitiseHistory(messages) {
  const out = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const ids = new Set(msg.tool_calls.map((tc) => tc.id))
      const answered = messages.slice(i + 1).some((m) => m.role === 'tool' && ids.has(m.tool_call_id))
      if (!answered) continue
    }
    if (msg.role === 'tool') {
      const requested = out.some((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === msg.tool_call_id))
      if (!requested) continue
    }
    out.push(msg)
  }
  return out
}

async function loadHistory(conversationID, limit = 20) {
  if (!conversationID) return []
  const { Message } = cds.entities('factorypilot.chat')
  const rows = await SELECT.from(Message).where({ conversation_ID: conversationID }).orderBy('seq').limit(limit)
  return sanitiseHistory(
    rows.map((r) => {
      const msg = { role: r.role, content: r.content || '' }
      if (r.toolCalls) {
        msg.tool_calls = llm.safeParse(r.toolCalls) || undefined
        msg.content = msg.content || null
      }
      if (r.toolCallId) {
        msg.tool_call_id = r.toolCallId
        msg.name = r.toolName
      }
      return msg
    })
  )
}

/**
 * @returns {{status, answer, toolsCalled, rounds, grounded, usage, steps, pendingAction}}
 */
async function run({ question, userID, roles, warehouseID, conversationID, correlationId, businessObjects, route, orgSettings }) {
  const provider = llm.getProvider(route || {})
  const definitions = tools.buildDefinitions(businessObjects)
  const defaults = { warehouse: warehouseID || orgSettings?.defaultWarehouse || '1000' }

  const messages = [
    { role: 'system', content: systemPrompt(businessObjects) },
    ...(await loadHistory(conversationID)),
    { role: 'user', content: question },
  ]

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false }
  const steps = []
  const toolsCalled = []
  const toolErrors = []
  let grounded = false
  let rounds = 0

  // A paid provider running out of credit, rate-limiting, or going down should
  // degrade the answer, not lose the question. The offline provider computes
  // its answer from the same real tool output, so the data stays true — only
  // the phrasing gets plainer. The swap is recorded rather than hidden: the
  // audit row and the response both say which provider actually answered.
  let active = provider
  let degradedFrom = null

  const complete = async (payload) => {
    try {
      return await active.complete(payload)
    } catch (err) {
      if (active instanceof llm.FakeProvider) throw err
      degradedFrom = `${active.name}: ${err.message}`
      console.warn(`[agent] ${active.name} failed (${err.message}) — answering from the offline provider instead`)
      active = new llm.FakeProvider()
      return active.complete(payload)
    }
  }

  while (rounds < MAX_ROUNDS) {
    rounds++
    const completion = await complete({
      messages,
      tools: definitions,
      maxTokens: route?.maxTokens || 800,
      temperature: route?.temperature != null ? Number(route.temperature) : 0.2,
    })

    usage.promptTokens += completion.promptTokens
    usage.completionTokens += completion.completionTokens
    usage.totalTokens += completion.totalTokens
    usage.isEstimated = usage.isEstimated || completion.isEstimated
    usage.provider = completion.provider
    usage.model = completion.model

    if (!completion.toolCalls?.length) {
      return settle({
        status: 'SUCCESS',
        answer: completion.text || '',
        toolsCalled,
        rounds,
        grounded,
        usage,
        steps,
        messages,
      })
    }

    messages.push({
      role: 'assistant',
      content: completion.text || null,
      tool_calls: completion.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      })),
    })

    for (const call of completion.toolCalls) {
      toolsCalled.push(call.name)

      if (tools.isWriteTool(call.name)) {
        // Stop here. The write is described, costed and audited, but not done.
        const decision = await policy.shouldAutoApprove({
          userID,
          warehouseID: call.arguments?.warehouseID || defaults.warehouse,
          args: call.arguments,
          recentQuantities: [],
          anomalyFactor: Number(orgSettings?.anomalyFactor || 5),
        })
        return {
          status: 'AWAITING_APPROVAL',
          answer: completion.text || '',
          toolsCalled,
          rounds,
          grounded,
          usage,
          steps,
          messages,
          pendingAction: {
            toolName: call.name,
            arguments: call.arguments || {},
            warehouseID: call.arguments?.warehouseID || defaults.warehouse,
            summary: describeWrite(call.arguments),
            anomalous: decision.anomaly.anomalous === true,
            anomalyReason: decision.anomaly.reason || '',
            autoApprovable: decision.autoApprove,
            policyReason: decision.reason,
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          },
        }
      }

      const startedAt = Date.now()
      let content
      try {
        const result = await tools.executeRead(call.name, call.arguments || {}, {
          businessObjects,
          defaults,
          correlationId,
        })
        grounded = true
        // Send a sample, not the whole result set. Sixty rows of S/4 columns
        // is roughly fifteen thousand tokens, which overruns a modest prompt
        // budget and costs real money on a generous one — for an answer the
        // model can give from a fraction of it. rowCount is the honest total,
        // and `truncated` stops the model presenting a sample as the whole.
        const SAMPLE = Number(process.env.FACTORYPILOT_TOOL_ROW_SAMPLE || 25)
        const sample = result.rows.slice(0, SAMPLE)
        content = JSON.stringify({
          rowCount: result.rows.length,
          returned: sample.length,
          truncated: result.rows.length > sample.length,
          rows: sample,
          url: result.url,
        })
        steps.push({
          toolName: call.name,
          arguments: JSON.stringify(call.arguments || {}),
          result: `${result.rows.length} rows`,
          durationMs: Date.now() - startedAt,
          url: result.url,
          backendMs: result.elapsedMs,
        })
      } catch (err) {
        content = JSON.stringify({ error: err.message })
        toolErrors.push(`${call.name}: ${err.message}`)
        steps.push({
          toolName: call.name,
          arguments: JSON.stringify(call.arguments || {}),
          result: '',
          durationMs: Date.now() - startedAt,
          error: err.message,
        })
      }

      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content })
    }
  }

  return settle({
    status: 'SUCCESS',
    answer: 'I could not complete that within the allowed number of tool rounds.',
    toolsCalled,
    rounds,
    grounded,
    usage,
    steps,
    messages,
    exhausted: true,
  })

  /**
   * Decide what a run that reached an answer is actually worth.
   *
   * The model is handed `{"error": ...}` as a tool result and will happily
   * narrate around it — the offline provider used to answer "No records
   * matched" for a warehouse whose endpoint was unreachable. That reads as
   * "there is no stock" rather than "I could not check", it was stored as
   * SUCCESS so nobody investigating saw a failure, and SUCCESS is also the
   * condition for writing to the answer cache, so the wrong answer outlived
   * the outage that caused it.
   *
   * Every tool call failing with nothing grounded is a failed run, whatever
   * the model chose to say. A partial failure stays SUCCESS: some data was
   * really fetched, and the caller can see the failed step in `steps`.
   */
  function settle(outcome) {
    if (outcome.answer) outcome = { ...outcome, answer: stripDeliberation(outcome.answer) }
    if (degradedFrom) {
      outcome = { ...outcome, degradedFrom, usage: { ...outcome.usage, degradedFrom } }
    }
    if (outcome.grounded || !toolErrors.length) return outcome
    return {
      ...outcome,
      status: 'FAILED',
      errorDetail: toolErrors.join('; '),
      answer:
        'I could not reach the source system for that question, so I have no data to answer it. ' +
        'This is a connection problem, not an empty result — please retry, and tell an administrator if it persists.',
    }
  }
}

function describeWrite(args = {}) {
  const { quantity, materialID, fromLocation, toLocation, warehouseID } = args
  const where = [fromLocation && `from ${fromLocation}`, toLocation && `to ${toLocation}`].filter(Boolean).join(' ')
  return `Move ${quantity ?? '?'} of ${materialID ?? '?'} ${where} in warehouse ${warehouseID ?? '?'}`.replace(/\s+/g, ' ').trim()
}

module.exports = { run, sanitiseHistory, systemPrompt, describeWrite, stripDeliberation, MAX_ROUNDS, PENDING_TTL_MS }
