using { factorypilot.config as db } from '../db/config';

type TestConnectionResult {
  ok         : Boolean;
  statusCode : Integer;
  message    : String(500);
  checkedUrl : String(500);
  elapsedMs  : Integer;
}

/**
 * Configuration plane: what backends exist, which business objects are
 * registered against them, and how long their answers may be cached.
 *
 * Separate from Admin because these are different jobs held by different
 * people — a functional consultant registers OData services; they do not
 * manage users or quotas.
 */
@path    : '/odata/config'
@requires: 'authenticated-user'
service ConfigService {

  // ToolCatalog below also projects BusinessObjectConfig; this marks which of
  // the two associations should redirect to.
  @cds.redirection.target
  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain'] },
    { grant: ['*'],    to: ['ConfigMaintain'] }
  ]
  entity BusinessObjects as projection on db.BusinessObjectConfig actions {
    action testConnection() returns TestConnectionResult;
  };

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain'] },
    { grant: ['*'],    to: ['ConfigMaintain'] }
  ]
  entity Connections as projection on db.Connection {
    *,
    // 3 green / 1 red for the last test result, set by an after-READ handler.
    virtual null as testCriticality : Integer
  } actions {
    action test() returns TestConnectionResult;
  };

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain', 'CacheMaintain'] },
    { grant: ['*'],    to: ['CacheMaintain', 'ConfigMaintain'] }
  ]
  entity CachePolicies as projection on db.CachePolicy;

  /** What the agent may call. Derived from the registry, so exposing a new
   *  tool is an `exposedAsTool` flag rather than a code change. */
  @readonly
  @restrict: [{ grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain', 'InsightsQuery'] }]
  view ToolCatalog as
    select from db.BusinessObjectConfig {
      key objectCode,
          objectName,
          moduleDomain,
          keywords,
          entitySet,
          promptHints
    }
    where isActive = true and exposedAsTool = true;
}
