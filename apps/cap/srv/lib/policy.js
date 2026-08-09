const cds = require('@sap/cds')

/**
 * Governance: may this user act on this warehouse, and may the agent do it
 * without asking a human?
 */

/** Admins bypass; everyone else needs an explicit `write` scope on that
 *  warehouse. A `read` scope is not a weaker write — it is not a write. */
async function canWrite(userID, warehouseID) {
  const { User, UserScope } = cds.entities('factorypilot.admin')
  const user = await SELECT.one.from(User).where({ userID, isActive: true })
  if (!user) return false
  if (user.isAdmin) return true
  const scope = await SELECT.one
    .from(UserScope)
    .where({ user_ID: user.ID, warehouseID, accessLevel: 'write' })
  return Boolean(scope)
}

const MOST_RESTRICTIVE = {
  autoApproveReads: (a, b) => a && b,
  autoApproveWrites: (a, b) => a && b,
  requireSecondApprover: (a, b) => a || b,
}

/**
 * Merge ORG, WAREHOUSE and USER policies.
 *
 * Most restrictive wins in every direction: a permissive user policy cannot
 * widen what the warehouse or the org allows, and the tightest write ceiling
 * anywhere applies. Layering it the other way would let a per-user exception
 * quietly defeat an org-wide control.
 */
async function effectivePolicy(userID, warehouseID) {
  const { ApprovalPolicy } = cds.entities('factorypilot.admin')
  const rows = await SELECT.from(ApprovalPolicy).where({ isActive: true })

  const applicable = rows.filter(
    (p) =>
      (p.scopeKind === 'ORG') ||
      (p.scopeKind === 'WAREHOUSE' && p.subject === warehouseID) ||
      (p.scopeKind === 'USER' && p.subject === userID)
  )

  if (!applicable.length) {
    // Nothing configured: reads flow, writes stop. Defaulting the other way
    // would let an unconfigured system act on a backend unattended.
    return {
      autoApproveReads: true,
      autoApproveWrites: false,
      writeCeiling: null,
      requireSecondApprover: false,
      decidedBy: 'default (no policy configured)',
    }
  }

  const merged = {
    autoApproveReads: true,
    autoApproveWrites: true,
    writeCeiling: null,
    requireSecondApprover: false,
  }
  for (const p of applicable) {
    merged.autoApproveReads = MOST_RESTRICTIVE.autoApproveReads(merged.autoApproveReads, p.autoApproveReads !== false)
    merged.autoApproveWrites = MOST_RESTRICTIVE.autoApproveWrites(merged.autoApproveWrites, p.autoApproveWrites === true)
    merged.requireSecondApprover = MOST_RESTRICTIVE.requireSecondApprover(merged.requireSecondApprover, p.requireSecondApprover === true)
    if (p.writeCeiling != null) {
      merged.writeCeiling = merged.writeCeiling == null ? p.writeCeiling : Math.min(merged.writeCeiling, p.writeCeiling)
    }
  }
  merged.decidedBy = applicable.map((p) => `${p.scopeKind}:${p.subject}`).join(', ')
  return merged
}

/**
 * Flag a write that is wildly out of line with recent activity.
 *
 * An anomalous action is never auto-approved regardless of policy — the point
 * is that the unusual case is exactly the one a human should see.
 */
function detectAnomaly(args, recentQuantities = [], factor = 5) {
  const quantity = Number(args?.quantity || 0)
  if (!quantity || recentQuantities.length < 3) return { anomalous: false }

  const avg = recentQuantities.reduce((a, b) => a + b, 0) / recentQuantities.length
  if (avg <= 0) return { anomalous: false }
  if (quantity >= avg * factor) {
    return {
      anomalous: true,
      reason: `Quantity ${quantity} is ${(quantity / avg).toFixed(1)}× the recent average of ${avg.toFixed(1)} across ${recentQuantities.length} moves.`,
    }
  }
  return { anomalous: false }
}

/**
 * Decide whether a proposed write can run unattended.
 * Every `false` here means a confirmation card goes to a human.
 */
async function shouldAutoApprove({ userID, warehouseID, args, recentQuantities, anomalyFactor = 5 }) {
  const policy = await effectivePolicy(userID, warehouseID)
  const anomaly = detectAnomaly(args, recentQuantities, anomalyFactor)

  if (anomaly.anomalous) return { autoApprove: false, policy, anomaly, reason: 'anomalous' }
  if (!policy.autoApproveWrites) return { autoApprove: false, policy, anomaly, reason: 'policy requires confirmation' }
  if (policy.requireSecondApprover) return { autoApprove: false, policy, anomaly, reason: 'second approver required' }
  if (policy.writeCeiling != null && Number(args?.quantity || 0) > policy.writeCeiling) {
    return { autoApprove: false, policy, anomaly, reason: `above the write ceiling of ${policy.writeCeiling}` }
  }
  return { autoApprove: true, policy, anomaly, reason: 'within policy' }
}

module.exports = { canWrite, effectivePolicy, detectAnomaly, shouldAutoApprove }
