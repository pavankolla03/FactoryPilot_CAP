const cds = require('@sap/cds')

module.exports = cds.service.impl(function () {
  const { BusinessObjects } = this.entities

  /**
   * objectCode is what the agent resolves a question to, and the OData path is
   * what it builds a query from. Both must exist before a row goes live, or the
   * tool appears in the catalogue and fails at the first question instead of
   * here, where it can be explained.
   */
  this.before(['CREATE', 'UPDATE'], BusinessObjects, (req) => {
    const d = req.data
    if (d.isActive) {
      if (!d.odataServicePath) req.error(400, 'odataServicePath is required to activate', 'odataServicePath')
      if (!d.entitySet) req.error(400, 'entitySet is required to activate', 'entitySet')
    }
    if (d.objectCode) d.objectCode = d.objectCode.toUpperCase()
  })

  // Pointing an active object at an endpoint that is switched off would fail at
  // the next question rather than at the change that caused it.
  this.before(['CREATE', 'UPDATE'], BusinessObjects, async (req) => {
    if (!req.data.endpoint_ID || req.data.isActive === false) return
    const { IntegrationEndpoint } = cds.entities('factorypilot.integration')
    const endpoint = await SELECT.one.from(IntegrationEndpoint).where({ ID: req.data.endpoint_ID })
    if (endpoint && !endpoint.isActive) {
      req.error(400, `Integration endpoint "${endpoint.name}" is inactive. Activate it first.`, 'endpoint_ID')
    }
  })
})
