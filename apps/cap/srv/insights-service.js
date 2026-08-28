const cds = require('@sap/cds')
const agent = require('./lib/agent')
const quota = require('./lib/quota')
const tools = require('./lib/tools')
const policy = require('./lib/policy')
const cache = require('./lib/cache')

const rolesOf = (req) => Object.keys(req.user?.roles || {}).filter((r) => !r.startsWith('$'))
const uuid = () => cds.utils.uuid()

/** Cost estimate used to reserve quota before the model runs. Deliberately
 *  generous — an over-reservation is refunded in reconcile, an under-estimate
 *  lets a user overshoot their cap. */
function estimateTokens(question, route) {
  return Math.ceil((question || '').length / 4) + (route?.maxTokens || 800)
}

async function loadContext() {
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const { ModelRoute } = cds.entities('factorypilot.token')
  const { OrgSettings } = cds.entities('factorypilot.admin')

  const [businessObjects, route, orgSettings] = await Promise.all([
    SELECT.from(BusinessObjectConfig).where({ isActive: true, exposedAsTool: true }),
    SELECT.one.from(ModelRoute).where({ isActive: true, route: 'heavy' }),
    SELECT.one.from(OrgSettings),
  ])
  return { businessObjects, route, orgSettings }
}

async function ensureConversation(conversationID, userID, question, channel) {
  const { Conversation } = cds.entities('factorypilot.chat')
  if (conversationID) {
    const existing = await SELECT.one.from(Conversation).where({ ID: conversationID })
    if (existing) {
      if (existing.userID !== userID) return { error: 'FORBIDDEN' }
      return { id: conversationID }
    }
  }
  const id = conversationID || uuid()
  await INSERT.into(Conversation).entries({
    ID: id,
    userID,
    channel: channel || 'Web',
    title: (question || '').slice(0, 120),
  })
  return { id }
}

async function nextSeq(conversationID) {
  const { Message } = cds.entities('factorypilot.chat')
  const row = await SELECT.one`max(seq) as maxSeq`.from(Message).where({ conversation_ID: conversationID })
  return (row?.maxSeq ?? 0) + 1
}

/** Persist the turns the loop produced so a follow-up question can reference
 *  data an earlier tool returned. */
async function persistTurns(conversationID, produced, startSeq) {
  const { Message } = cds.entities('factorypilot.chat')
  const rows = []
  let seq = startSeq
  for (const msg of produced) {
    rows.push({
      ID: uuid(),
      conversation_ID: conversationID,
      seq: seq++,
      timestamp: new Date(),
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : msg.content == null ? null : JSON.stringify(msg.content),
      toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
      toolCallId: msg.tool_call_id || null,
      toolName: msg.name || null,
    })
  }
  if (rows.length) await INSERT.into(Message).entries(rows)
  return seq
}

async function writeAudit({ result, userID, channel, question, conversationID, correlationId, quotaResult, startedAt, objectCode, status, errorDetail, cacheResult = 'NOT_APPLICABLE' }) {
  const { SessionLog, AgentRun, AgentStep } = cds.entities('factorypilot.audit')
  const logID = uuid()
  const runID = uuid()
  const finishedAt = new Date()

  await INSERT.into(SessionLog).entries({
    ID: logID,
    timestamp: finishedAt,
    userID,
    channel: channel || 'Web',
    conversationID,
    objectCode: objectCode || '',
    userQuery: (question || '').slice(0, 1000),
    toolsCalled: (result?.toolsCalled || []).join(',').slice(0, 500),
    backendUrlCalled: (result?.steps || []).find((s) => s.url)?.url?.slice(0, 500) || '',
    backendTimeMs: (result?.steps || []).reduce((n, s) => n + (s.backendMs || 0), 0),
    cacheResult,
    quotaResult,
    llmProvider: result?.usage?.provider || '',
    llmModel: result?.usage?.model || '',
    tokensUsed: result?.usage?.totalTokens || 0,
    totalResponseTimeMs: Date.now() - startedAt,
    status,
    grounded: result?.grounded === true,
    responseSummary: (result?.answer || '').slice(0, 2000),
    errorDetail: (errorDetail || '').slice(0, 1000),
    correlationId,
  })

  if (result) {
    await INSERT.into(AgentRun).entries({
      ID: runID,
      startedAt: new Date(startedAt),
      finishedAt,
      userID,
      conversationID,
      goal: (question || '').slice(0, 500),
      rounds: result.rounds || 0,
      toolCallCount: (result.toolsCalled || []).length,
      status,
      outcome: (result.answer || '').slice(0, 2000),
    })
    if (result.steps?.length) {
      await INSERT.into(AgentStep).entries(
        result.steps.map((s, i) => ({
          ID: uuid(),
          run_ID: runID,
          seq: i + 1,
          toolName: s.toolName,
          arguments: s.arguments,
          result: s.result,
          durationMs: s.durationMs,
          error: s.error || null,
        }))
      )
    }
  }

  return { logID, runID }
}

async function recordTokenUsage({ userID, conversationID, usage, latencyMs }) {
  if (!usage?.totalTokens) return
  const { TokenUsage } = cds.entities('factorypilot.token')
  await INSERT.into(TokenUsage).entries({
    ID: uuid(),
    timestamp: new Date(),
    userID,
    conversationID,
    provider: usage.provider || '',
    model: usage.model || '',
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    totalTokens: usage.totalTokens || 0,
    isEstimated: usage.isEstimated === true,
    route: 'heavy',
    latencyMs,
  })
}

module.exports = cds.service.impl(function () {
  // Reports how this instance is actually running, so the page can say so
  // rather than claiming live S/4 data while replaying fixtures.
  this.on('health', async () =>
    JSON.stringify({
      status: 'ok',
      demoMode: ['1', 'true', 'yes'].includes(String(process.env.FACTORYPILOT_DEMO_MODE || '').toLowerCase()),
      provider: process.env.LLM_PROVIDER || (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'fake'),
    })
  )

  this.on('ask', async (req) => {
    const startedAt = Date.now()
    const userID = req.user.id
    const roles = rolesOf(req)
    const correlationId = req.headers?.['x-correlation-id'] || uuid()
    const { question, channel, warehouseID } = req.data

    if (!question || !question.trim()) return req.reject(400, 'question is required')

    // Identity comes from the token, so a first-time caller has no row and was
    // invisible to whoever has to grant them warehouse scope. Provisioning here
    // grants nothing — it only puts them in the Admin list to be decided on.
    await policy.ensureUser(userID, { displayName: req.user.attr?.name, defaultWarehouse: warehouseID })

    const { businessObjects, route, orgSettings } = await loadContext()
    if (!businessObjects.length) {
      return {
        status: 'ERROR',
        errorCode: 'NO_ACTIVE_BUSINESS_OBJECTS',
        message: 'No business object is registered and active. Register one in the config console.',
        metadata: { correlationId },
      }
    }

    // Quota is checked before any model or backend call, so a user over their
    // limit costs nothing to refuse.
    const reservation = await quota.checkAndReserve(userID, roles, estimateTokens(question, route))
    if (reservation.decision === 'DENIED') {
      const { logID } = await writeAudit({
        result: null,
        userID,
        channel,
        question,
        conversationID: req.data.conversationID,
        correlationId,
        quotaResult: 'DENIED',
        startedAt,
        status: 'RATE_LIMITED',
        errorDetail: `${reservation.exceededWindow} limit exceeded`,
      })
      return {
        status: 'RATE_LIMITED',
        errorCode: 'QUOTA_EXCEEDED',
        message: `${(reservation.exceededWindow || 'DAY').toLowerCase()} limit exceeded. Try again after the next reset window.`,
        metadata: { logID, correlationId, quotaResult: 'DENIED', tokensUsed: 0, totalResponseTimeMs: Date.now() - startedAt },
      }
    }

    const conversation = await ensureConversation(req.data.conversationID, userID, question, channel)
    if (conversation.error) return req.reject(403, 'That conversation belongs to another user')
    const conversationID = conversation.id

    // Cache lookup happens *after* the quota gate, never before: a cached
    // answer still consumes the user's quota (ADR-009). Checking the cache
    // first would let anyone over their limit keep asking for free, which is
    // the loophole that makes a quota unenforceable.
    const cachePolicy = await cache.resolvePolicy(null, '')
    let cacheKey = null
    let cacheResult = 'NOT_APPLICABLE'

    if (cachePolicy?.cacheEnabled) {
      cacheKey = cache.buildKey({
        question,
        warehouseID,
        strategy: cachePolicy.cacheKeyStrategy,
        userID,
        roles,
      })
      const hit = await cache.get(cacheKey)
      if (hit) {
        cacheResult = 'HIT'
        await cache.recordStat(hit.objectCode || '', 'hits', hit.tokensUsed || 0)
        // Reservation is refunded: a hit spends no model tokens, so a
        // TOKEN_COUNT quota should not be charged for one.
        await quota.reconcile(userID, roles, reservation.reserved, 0)

        const { logID } = await writeAudit({
          result: {
            answer: hit.answer, toolsCalled: hit.toolsCalled || [], steps: [],
            usage: {}, grounded: hit.grounded, rounds: 0,
          },
          userID, channel, question, conversationID, correlationId,
          quotaResult: 'ALLOWED', startedAt, objectCode: hit.objectCode || '', status: 'SUCCESS',
          cacheResult: 'HIT',
        })

        return {
          status: 'SUCCESS',
          answer: hit.answer,
          metrics: JSON.stringify({ rounds: 0, toolCalls: 0, grounded: hit.grounded, servedFromCache: true }),
          metadata: {
            conversationID, logID, correlationId,
            objectCode: hit.objectCode || '',
            cacheResult: 'HIT',
            quotaResult: 'ALLOWED',
            tokensUsed: 0,
            totalResponseTimeMs: Date.now() - startedAt,
            rounds: 0,
            toolsCalled: (hit.toolsCalled || []).join(','),
            grounded: hit.grounded,
            provider: 'cache',
            model: hit.model || '',
          },
        }
      }
      cacheResult = 'MISS'
      await cache.recordStat('', 'misses')
    }

    let result
    let status = 'SUCCESS'
    let errorDetail = ''
    try {
      result = await agent.run({
        question,
        userID,
        roles,
        warehouseID,
        conversationID,
        correlationId,
        businessObjects,
        route,
        orgSettings,
      })
      status = result.status
      // A run that reached an answer but grounded none of it reports why here.
      errorDetail = result.errorDetail || ''
    } catch (err) {
      status = 'FAILED'
      errorDetail = err.message
    }

    // Settle the reservation whatever happened — a failed run must give back
    // everything it reserved.
    await quota.reconcile(userID, roles, reservation.reserved, result?.usage?.totalTokens || 0)
    await recordTokenUsage({ userID, conversationID, usage: result?.usage, latencyMs: Date.now() - startedAt })

    if (!result) {
      const { logID } = await writeAudit({
        result: null, userID, channel, question, conversationID, correlationId,
        quotaResult: 'ALLOWED', startedAt, status: 'FAILED', errorDetail,
      })
      return {
        status: 'ERROR',
        errorCode: 'AGENT_FAILED',
        message: 'The assistant could not complete that request.',
        metadata: { logID, conversationID, correlationId, totalResponseTimeMs: Date.now() - startedAt },
      }
    }

    // Persist the user turn plus everything the loop produced.
    const startSeq = await nextSeq(conversationID)
    const produced = [{ role: 'user', content: question }, ...result.messages.slice(result.messages.findIndex((m) => m.role === 'user') + 1)]
    await persistTurns(conversationID, produced, startSeq)

    let pendingCard = null
    if (result.status === 'AWAITING_APPROVAL' && result.pendingAction) {
      const { PendingAction } = cds.entities('factorypilot.audit')
      const actionID = uuid()
      await INSERT.into(PendingAction).entries({
        ID: actionID,
        createdAt: new Date(),
        expiresAt: result.pendingAction.expiresAt,
        userID,
        conversationID,
        toolName: result.pendingAction.toolName,
        arguments: JSON.stringify(result.pendingAction.arguments),
        warehouseID: result.pendingAction.warehouseID,
        summary: result.pendingAction.summary,
        anomalous: result.pendingAction.anomalous,
        anomalyReason: result.pendingAction.anomalyReason,
        status: 'PENDING',
      })
      pendingCard = {
        actionID,
        toolName: result.pendingAction.toolName,
        summary: result.pendingAction.summary,
        arguments: JSON.stringify(result.pendingAction.arguments),
        warehouseID: result.pendingAction.warehouseID,
        anomalous: result.pendingAction.anomalous,
        anomalyReason: result.pendingAction.anomalyReason,
        expiresAt: result.pendingAction.expiresAt,
      }
    }

    const objectCode = (result.toolsCalled || [])
      .filter((t) => t.startsWith('query_'))
      .map((t) => t.replace('query_', '').toUpperCase())[0] || ''

    // Cache only a completed read. A proposed write must never be replayed
    // from cache — the second person to ask would get a confirmation card for
    // an action that was already approved and executed. Errors and rate-limit
    // outcomes are not answers and are not cached either.
    if (cacheKey && result.status === 'SUCCESS' && !result.pendingAction) {
      const objectPolicy = await cache.resolvePolicy(objectCode, '')
      if (objectPolicy?.cacheEnabled) {
        const ttl = cache.effectiveTtl(objectPolicy, question)
        // Reuse the key the lookup computed. Rebuilding it from the
        // now-known objectCode would write to a key no lookup ever reads.
        await cache.set(
          cacheKey,
          {
            answer: result.answer,
            objectCode,
            toolsCalled: result.toolsCalled || [],
            grounded: result.grounded === true,
            tokensUsed: result.usage?.totalTokens || 0,
            model: result.usage?.model || '',
          },
          ttl
        )
        await cache.recordStat(objectCode, 'writes')
      }
    }

    const { logID, runID } = await writeAudit({
      result, userID, channel, question, conversationID, correlationId,
      quotaResult: 'ALLOWED', startedAt, objectCode, status, errorDetail, cacheResult,
    })

    return {
      status: result.status,
      answer: (result.answer || '').slice(0, 4000),
      metrics: JSON.stringify({ rounds: result.rounds, toolCalls: result.toolsCalled.length, grounded: result.grounded }),
      pendingAction: pendingCard,
      metadata: {
        conversationID,
        logID,
        runID,
        correlationId,
        objectCode,
        cacheResult,
        quotaResult: 'ALLOWED',
        tokensUsed: result.usage?.totalTokens || 0,
        totalResponseTimeMs: Date.now() - startedAt,
        rounds: result.rounds,
        toolsCalled: result.toolsCalled.join(','),
        grounded: result.grounded,
        provider: result.usage?.provider || '',
        model: result.usage?.model || '',
      },
    }
  })

  /**
   * The only path that mutates a backend.
   *
   * Consumption is a conditional UPDATE, so a replayed actionID finds nothing
   * in PENDING and is refused. Checking-then-updating would let a double-click
   * post the same goods movement twice.
   */
  this.on('confirmAction', async (req) => {
    const startedAt = Date.now()
    const { actionID, approve } = req.data
    const userID = req.user.id
    const { PendingAction } = cds.entities('factorypilot.audit')

    const action = await SELECT.one.from(PendingAction).where({ ID: actionID })
    if (!action) return { status: 'ERROR', errorCode: 'ACTION_NOT_FOUND', message: 'No such pending action.' }
    if (action.userID !== userID && !req.user.is('AdminMaintain')) {
      return req.reject(403, 'That action belongs to another user')
    }

    const nextStatus = approve === false ? 'REJECTED' : 'CONSUMED'
    const affected = await UPDATE(PendingAction)
      .set({ status: nextStatus, approvedBy: userID, resolvedAt: new Date() })
      .where({ ID: actionID, status: 'PENDING' })

    if (!affected) {
      return {
        status: 'ERROR',
        errorCode: 'ACTION_EXPIRED',
        message: `This action was already ${String(action.status).toLowerCase()} and cannot be run again.`,
      }
    }

    if (new Date(action.expiresAt).getTime() < Date.now()) {
      await UPDATE(PendingAction).set({ status: 'EXPIRED' }).where({ ID: actionID })
      return { status: 'ERROR', errorCode: 'ACTION_EXPIRED', message: 'This confirmation expired. Ask again to get a fresh one.' }
    }

    if (approve === false) {
      return { status: 'SUCCESS', answer: 'Action rejected. Nothing was changed.', metadata: { correlationId: actionID } }
    }

    // Maker-checker: approving your own proposal is only allowed when policy
    // does not require a second person.
    const effective = await policy.effectivePolicy(action.userID, action.warehouseID)
    if (effective.requireSecondApprover && action.userID === userID) {
      await UPDATE(PendingAction).set({ status: 'PENDING', approvedBy: null, resolvedAt: null }).where({ ID: actionID })
      return {
        status: 'ERROR',
        errorCode: 'SECOND_APPROVER_REQUIRED',
        message: 'Policy requires a different person to approve this action.',
      }
    }

    if (!(await policy.canWrite(userID, action.warehouseID, { isPlatformAdmin: req.user.is('AdminMaintain') }))) {
      await UPDATE(PendingAction).set({ status: 'REJECTED', resolvedAt: new Date() }).where({ ID: actionID })
      return {
        status: 'ERROR',
        errorCode: 'SCOPE_DENIED',
        message: `You do not have write access to warehouse ${action.warehouseID}.`,
      }
    }

    const args = JSON.parse(action.arguments || '{}')
    let outcome
    try {
      outcome = await tools.executeWrite(action.toolName, args)
    } catch (err) {
      await UPDATE(PendingAction).set({ status: 'REJECTED' }).where({ ID: actionID })
      return { status: 'ERROR', errorCode: 'WRITE_FAILED', message: err.message }
    }

    const { logID } = await writeAudit({
      result: { toolsCalled: [action.toolName], steps: [], answer: outcome.note, usage: {}, grounded: true, rounds: 0 },
      userID,
      channel: 'Web',
      question: `confirm: ${action.summary}`,
      conversationID: action.conversationID,
      correlationId: actionID,
      quotaResult: 'ALLOWED',
      startedAt,
      status: 'SUCCESS',
    })

    return {
      status: 'SUCCESS',
      answer: `${action.summary} — done. ${outcome.note}`,
      metrics: JSON.stringify(outcome),
      metadata: { logID, correlationId: actionID, totalResponseTimeMs: Date.now() - startedAt },
    }
  })

  // A user only ever sees their own conversations.
  this.before('READ', 'Conversations', (req) => {
    if (!req.user.is('AdminMaintain')) req.query.where({ userID: req.user.id })
  })
})
