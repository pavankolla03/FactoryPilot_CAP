using factorypilot as db from '../db/schema';

type TestConnectionResult {
  ok         : Boolean;
  statusCode : Integer;
  message    : String(500);
  checkedUrl : String(500);
}

/**
 * Admin console backend. Four areas, one service:
 * BO/OData registry, rate limits, cache policy, communication log.
 *
 * Business users never reach this service — every entity requires an admin
 * scope. Insights traffic goes to the orchestrator instead (ADR-015).
 */
@path    : '/odata/admin'
@requires: 'authenticated-user'
service AdminService {

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain'] },
    { grant: ['*'],    to: ['ConfigMaintain'] }
  ]
  entity BusinessObjectConfigs as projection on db.BusinessObjectConfig actions {
    @Common.SideEffects: { TargetProperties: ['in/isActive'] }
    action testConnection() returns TestConnectionResult;
  };

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'RateLimitMaintain', 'DashboardRead', 'DashboardAdmin'] },
    { grant: ['*'],    to: ['RateLimitMaintain'] }
  ]
  entity UserRateLimitConfigs as projection on db.UserRateLimitConfig;

  @readonly
  @restrict: [
    { grant: ['READ'], to: ['RateLimitMaintain', 'DashboardRead', 'DashboardAdmin'] }
  ]
  entity UserConsumptions as projection on db.UserConsumption;

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'CacheMaintain'] },
    { grant: ['*'],    to: ['CacheMaintain'] }
  ]
  entity CacheConfigs as projection on db.CacheConfig;

  @readonly
  @restrict: [
    { grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin'] }
  ]
  entity CommunicationLogs as projection on db.CommunicationLog {
    *,
    // 3 = green, 2 = amber, 1 = red. Filled in by an after-READ handler so the
    // log explorer is scannable without reading the status column.
    virtual null as statusCriticality : Integer
  };

  /** Dashboard tiles — aggregate counts the Fiori overview page reads. */
  @readonly
  @restrict: [
    { grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin'] }
  ]
  view UsageByObject as
    select from db.CommunicationLog {
      key objectCode,
          count(*)             as requests    : Integer,
          sum(tokensUsed)      as tokensUsed  : Integer,
          sum(
            case when cacheResult = 'HIT' then 1 else 0 end
          )                    as cacheHits   : Integer
    }
    group by objectCode;
}
