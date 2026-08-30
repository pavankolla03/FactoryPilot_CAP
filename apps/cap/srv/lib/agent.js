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

// Rounds are also bounded by wall-clock, not just by count. MAX_ROUNDS alone
// permits eight model calls plus their tool calls, which comfortably outlasts
// any gateway: the approuter gives up at its destination timeout and the caller
// sees a bare 504 instead of an answer.
const MIN_ROUND_MS = Number(process.env.FACTORYPILOT_MIN_ROUND_MS || 8000)
const ROUND_RESERVE_MS = Number(process.env.FACTORYPILOT_ROUND_RESERVE_MS || 6000)
const PENDING_TTL_MS = 15 * 60 * 1000

function systemPrompt(businessObjects, defaults = {}) {
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
    '5. If a tool returns no rows, say which filter was used — quote `queriedWith` — so the reader can see whether the plant or material was the problem rather than the data.',
    '6. Only call a tool when the question is about the registered business objects below. Anything else — a greeting, a general question, something outside SAP — answer directly and do not call a tool.',
    defaults.warehouse
      ? `7. The user is currently working in plant ${defaults.warehouse}. Pass warehouseID="${defaults.warehouse}" on every tool call unless the question names a different plant. Never ask the user which plant — you have been told.`
      : '7. No plant is selected. If a question needs one and names none, say so rather than guessing.',
    '8. Prefer a short markdown table when reporting more than three figures. Keep prose to two or three sentences.',
    // The UI renders a markdown table as a table *or* a bar chart, switchable.
    // Left to itself a model asked for a chart draws one out of ASCII, which
    // cannot be read, sorted or copied — and its numbers can disagree with the
    // table above it. One format, two renderings, no second source of truth.
    '9. When asked for a chart, graph, dashboard or visualisation, still answer with a normal markdown table — the interface draws it. Never attempt ASCII art. Put the label in the first column and the number in the second, and sort by the number, largest first.',
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
async function run({ question, userID, roles, warehouseID, conversationID, correlationId, businessObjects, route, orgSettings, deadlineAt }) {
  const providers = llm.getProviderChain(route || {})
  const definitions = tools.buildDefinitions(businessObjects)
  // No literal fallback. A hardcoded plant silently redirects every question
  // to a site that may not exist in this tenant, and the only symptom is an
  // empty answer — which has now happened twice, with '1000' both times.
  const defaults = { warehouse: warehouseID || orgSettings?.defaultWarehouse || '' }

  const messages = [
    { role: 'system', content: systemPrompt(businessObjects, defaults) },
    ...(await loadHistory(conversationID)),
    { role: 'user', content: question },
  ]

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false }
  const steps = []
  const toolsCalled = []
  const toolErrors = []
  let grounded = false
  let rounds = 0
  let ranOutOfTime = false

  // A provider running out of credit, rate-limiting, or going down should
  // degrade the answer, not lose the question — so this walks a chain rather
  // than collapsing to the offline provider on the first failure. That matters
  // most for the free tier that leads it: free quota runs out partway through a
  // day, and it runs out mid-demo. The paid key is the next rung, not the last
  // resort.
  //
  // The offline provider is always last, and computes its answer from the same
  // real tool output — so the data stays true and only the phrasing gets
  // plainer. Every swap is recorded rather than hidden: the audit row and the
  // response both say which provider actually answered, and why the one before
  // it did not.
  let rung = 0
  let active = providers[0]
  let degradedFrom = null

  // How long is left before the caller's gateway gives up on us. Every model
  // call is capped by it, and a new round is only started if there is room for
  // one — otherwise the loop runs on past the deadline, the gateway returns
  // 504, and the user gets no answer at all instead of a partial one.
  const timeLeft = () => (deadlineAt ? deadlineAt - Date.now() : Infinity)

  // A model call must leave enough behind to run the tools it asks for and to
  // file the audit row, or we would meet the deadline with nothing recorded.
  const remainingForModel = () => {
    const left = timeLeft()
    return Number.isFinite(left) ? Math.max(2000, left - ROUND_RESERVE_MS) : undefined
  }

  const complete = async (payload) => {
    for (;;) {
      try {
        return await active.complete({ ...payload, timeoutMs: remainingForModel() })
      } catch (err) {
        const failure = `${active.name}: ${err.message}`
        // Nothing left below us. The last rung is the offline provider, so
        // reaching here means even that failed and the run genuinely cannot
        // continue.
        if (rung >= providers.length - 1) throw err
        active = providers[++rung]
        degradedFrom = degradedFrom ? `${degradedFrom}; ${failure}` : failure
        console.warn(`[agent] ${failure} — trying ${active.name}`)
      }
    }
  }

  while (rounds < MAX_ROUNDS) {
    // Starting a round we cannot finish spends the remaining budget and then
    // gets cut off mid-flight by the gateway. Stopping here means the user
    // sees what we did manage to find out, and why it stopped.
    if (rounds > 0 && timeLeft() < MIN_ROUND_MS) {
      return settle({
        status: 'SUCCESS',
        answer: grounded
          ? 'I ran out of time before I could finish working through that. Here is what I had gathered — ask again, or narrow the question, for the rest.'
          : 'That took longer than I am allowed to spend on one question. Please try again, or narrow it to a single plant or material.',
        toolsCalled,
        rounds,
        grounded,
        usage,
        steps,
        messages,
        timedOut: true,
      })
    }
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

      // The model can ask for several tools in one round. Each is bounded on
      // its own, but three of them in sequence are not, so the budget is
      // checked between them as well as between rounds.
      if (timeLeft() < ROUND_RESERVE_MS) {
        // Deliberately *not* recorded in toolErrors. Those mean "the backend
        // did not answer", and settle() turns a run of nothing but those into
        // "I could not reach the source system" — which would send an operator
        // hunting an outage when the truth is that the question was slow.
        ranOutOfTime = true
        content = JSON.stringify({ error: 'skipped: ran out of time for this question' })
        steps.push({
          toolName: call.name,
          arguments: JSON.stringify(call.arguments || {}),
          result: '',
          durationMs: 0,
          error: 'skipped: out of time',
        })
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content })
        continue
      }

      try {
        const result = await tools.executeRead(call.name, call.arguments || {}, {
          businessObjects,
          defaults,
          correlationId,
          timeoutMs: Number.isFinite(timeLeft()) ? Math.max(2000, timeLeft() - 2000) : undefined,
        })
        grounded = true
        // Send a sample, not the whole result set. Sixty rows of S/4 columns
        // is roughly fifteen thousand tokens, which overruns a modest prompt
        // budget and costs real money on a generous one — for an answer the
        // model can give from a fraction of it. rowCount is the honest total,
        // and `truncated` stops the model presenting a sample as the whole.
        const SAMPLE = Number(process.env.FACTORYPILOT_TOOL_ROW_SAMPLE || 25)
        const sample = result.rows.slice(0, SAMPLE)
        // The filter is part of the result. Without it an empty answer reads
        // as "there is no stock" when the truth is "plant 1000 has no stock,
        // and you may have meant another plant" — the query that was actually
        // run is the difference between those two sentences.
        const askedFilter = (result.url || '').match(/\$filter=([^&]*)/)?.[1] || ''
        content = JSON.stringify({
          rowCount: result.rows.length,
          returned: sample.length,
          truncated: result.rows.length > sample.length,
          queriedWith: decodeURIComponent(askedFilter) || '(no filter)',
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

    // The answer has to join the transcript. It was returned alongside
    // `messages` but never pushed into it, so persistTurns saved the question
    // and the tool call and not the reply: reopening a conversation showed the
    // user's turns with nothing under them, and a follow-up question was sent
    // to the model without its own previous answers for context.
    if (outcome.answer) {
      outcome = { ...outcome, messages: [...(outcome.messages || []), { role: 'assistant', content: outcome.answer }] }
    }
    if (degradedFrom) {
      outcome = { ...outcome, degradedFrom, usage: { ...outcome.usage, degradedFrom } }
    }
    if (outcome.grounded || !toolErrors.length) return outcome
    // Running out of time is its own failure with its own remedy. Reporting it
    // as an unreachable backend sends the reader to the wrong problem.
    if (ranOutOfTime) return { ...outcome, timedOut: true }
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
