#!/usr/bin/env node
/**
 * Which free OpenRouter models can actually drive this app?
 *
 * OpenRouter's model metadata lists ~18 free models as supporting `tools`.
 * Probing them with this app's own tool schema, fewer than half of them do
 * anything useful: some return no choices at all once tools are present, some
 * answer a warehouse question in prose without calling the tool, and some are
 * gated to "agentic harnesses". A model that cannot call a tool cannot answer a
 * warehouse question — it can only sound like it did.
 *
 * So the ModelRoute rows are chosen from evidence, not from metadata, and this
 * is where the evidence comes from. Free availability shifts weekly; rerun it
 * when answers start coming from the paid fallback more often than they should.
 *
 *   node scripts/openrouter-probe.js                    # every free tool-capable model
 *   node scripts/openrouter-probe.js <model> [<model>]  # just these
 *
 * A 429 means "rate-limited right now", not "incapable" — rerun before ruling
 * a model out on that alone.
 *
 * Needs OPENROUTER_API_KEY.
 */

// Does this model actually drive our tool loop? Two things must both work:
// it must emit a tool call for a warehouse question, and it must answer a
// plain greeting in prose without calling one.
const KEY = process.env.OPENROUTER_API_KEY
const TOOLS = [{
  type: 'function',
  function: {
    name: 'query_material_stock',
    description: 'Query Material Stock records from SAP S/4HANA. keywords: stock, inventory, on hand',
    parameters: { type: 'object', properties: {
      warehouseID: { type: 'string', description: 'plant' },
      materialID: { type: 'string' },
    } },
  },
}]

async function ask(model, messages, withTools) {
  const body = { model, messages, max_tokens: 900, temperature: 0.2, reasoning: { exclude: true } }
  if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto' }
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000)
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'FactoryPilot' },
      body: JSON.stringify(body), signal: c.signal,
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { err: `${r.status} ${(j.error?.metadata?.raw || j.error?.message || '').slice(0, 70)}` }
    const ch = j.choices?.[0]
    if (!ch) return { err: 'no choices' }
    return { text: (ch.message?.content || '').trim(), calls: ch.message?.tool_calls || [], finish: ch.finish_reason }
  } catch (e) { return { err: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 50) } }
  finally { clearTimeout(t) }
}

/** Every free model OpenRouter says supports tools — the candidate pool. */
async function freeToolModels() {
  const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { Accept: 'application/json' } })
  const { data = [] } = await r.json()
  return data
    .filter((m) => {
      const free = String(m.id).endsWith(':free') ||
        (Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0)
      return free && (m.supported_parameters || []).includes('tools')
    })
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .map((m) => m.id)
}

;(async () => {
  if (!KEY) {
    console.error('OPENROUTER_API_KEY is not set.\n')
    console.error("  cf env factorypilot-srv | grep OPENROUTER_API_KEY   # the deployed one")
    process.exit(1)
  }
  const models = process.argv.slice(2).length ? process.argv.slice(2) : await freeToolModels()
  console.log(`Probing ${models.length} model(s) with this app's tool schema.\n`)
  for (const m of models) {
    const tool = await ask(m, [
      { role: 'system', content: 'You are a warehouse copilot. Use the tools to fetch real data.' },
      { role: 'user', content: 'How much stock do we have in plant 1710?' },
    ], true)
    const chat = await ask(m, [
      { role: 'system', content: 'You are a warehouse copilot. Only call a tool when the question is about warehouse data.' },
      { role: 'user', content: 'hello, what is your name?' },
    ], true)

    const toolOK = !tool.err && tool.calls.length > 0
    const chatOK = !chat.err && chat.calls.length === 0 && chat.text.length > 0
    const verdict = toolOK && chatOK ? 'USABLE' : toolOK ? 'tools ok, chat weak' : 'NOT USABLE'
    console.log(
      `${m.padEnd(46)} ${verdict.padEnd(18)}` +
      ` tools:${tool.err ? 'ERR ' + tool.err : tool.calls.length ? 'called ' + tool.calls[0].function.name : 'none(' + tool.finish + ')'}` +
      ` | chat:${chat.err ? 'ERR ' + chat.err : chat.calls.length ? 'called a tool!' : JSON.stringify(chat.text.slice(0, 42))}`
    )
  }
})()
