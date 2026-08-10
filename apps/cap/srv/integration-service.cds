using { factorypilot.integration as db } from '../db/integration';

type EndpointTestResult {
  status     : String(20);   // OK | FAILED | UNCONFIGURED
  httpStatus : Integer;
  durationMs : Integer;
  urlTested  : String(400);
  message    : String(500);
}

/**
 * Integration plane — which iFlows and services this deployment may call.
 *
 * Its own service so a client can let an integration engineer register their
 * own iFlow endpoints without also handing them quotas, users or the audit
 * trail. Registering an endpoint is data entry; nothing here requires a
 * deploy.
 */
@path    : '/odata/integration'
@requires: 'authenticated-user'
service IntegrationService {

  // UsableEndpoints also projects IntegrationEndpoint; this picks which one
  // EndpointTests.endpoint redirects to.
  @cds.redirection.target
  @restrict: [
    { grant: ['READ'], to: ['IntegrationRead', 'IntegrationMaintain', 'ConfigRead'] },
    { grant: ['*'],    to: ['IntegrationMaintain'] }
  ]
  entity Endpoints as projection on db.IntegrationEndpoint {
    *,
    // 3 green / 1 red / 0 never tested — drives the list colour.
    virtual null as testCriticality : Integer
  } actions {
    /** Really calls the endpoint. Records the outcome either way. */
    action test() returns EndpointTestResult;
  };

  @readonly
  @restrict: [{ grant: ['READ'], to: ['IntegrationRead', 'IntegrationMaintain', 'ConfigRead'] }]
  entity EndpointTests as projection on db.EndpointTest;

  /**
   * Endpoints an admin may safely pick for a business object: active, and
   * either proven by a test or not needing one.
   */
  @readonly
  @restrict: [{ grant: ['READ'], to: ['IntegrationRead', 'IntegrationMaintain', 'ConfigRead'] }]
  view UsableEndpoints as
    select from db.IntegrationEndpoint {
      key ID,
          name,
          kind,
          url,
          lastTestStatus
    }
    where isActive = true;
}
