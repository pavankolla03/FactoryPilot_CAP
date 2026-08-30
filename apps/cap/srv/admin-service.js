const cds = require('@sap/cds')
const policy = require('./lib/policy')

module.exports = cds.service.impl(function () {
  this.on('effectivePolicy', async (req) => {
    const { userID, warehouseID } = req.data
    return await policy.effectivePolicy(userID || req.user.id, warehouseID)
  })

  this.on('canWrite', async (req) => {
    const { userID, warehouseID } = req.data
    return await policy.canWrite(userID || req.user.id, warehouseID)
  })

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'UserScopes', (req) => {
    const level = req.data.accessLevel
    if (level && !['read', 'write'].includes(level)) {
      req.error(400, "accessLevel must be 'read' or 'write'", 'accessLevel')
    }
  })

  this.before(['CREATE', 'UPDATE', 'SAVE'], 'ApprovalPolicies', (req) => {
    const { scopeKind, subject, writeCeiling } = req.data
    if (scopeKind && !['USER', 'WAREHOUSE', 'ORG'].includes(scopeKind)) {
      req.error(400, "scopeKind must be USER, WAREHOUSE or ORG", 'scopeKind')
    }
    if (scopeKind && scopeKind !== 'ORG' && !subject) {
      req.error(400, `A ${scopeKind} policy needs a subject to apply to`, 'subject')
    }
    if (writeCeiling != null && writeCeiling < 0) req.error(400, 'writeCeiling cannot be negative', 'writeCeiling')
  })

  // Removing the last admin locks everyone out of configuration, and the only
  // way back is a database edit. Refuse it here.
  this.before(['UPDATE', 'DELETE'], 'Users', async (req) => {
    const { User } = cds.entities('factorypilot.admin')
    const id = req.params[0]?.ID ?? req.params[0]
    const target = await SELECT.one.from(User).where({ ID: id })
    if (!target?.isAdmin) return

    const losingAdmin = req.event === 'DELETE' || req.data.isAdmin === false || req.data.isActive === false
    if (!losingAdmin) return

    const others = await SELECT.one`count(*) as n`.from(User).where({ isAdmin: true, isActive: true, ID: { '!=': id } })
    if (!others?.n) req.error(400, 'This is the last active administrator — promote another user first')
  })
})
