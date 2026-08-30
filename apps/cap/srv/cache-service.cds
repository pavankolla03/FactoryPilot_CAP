using { factorypilot.cache as db } from '../db/cache';

type PurgeResult {
  removed    : Integer;
  objectCode : String(30);
  backend    : String(20);
}

type CacheHealth {
  backend        : String(20);
  policiesActive : Integer;
  hitRatio       : Decimal(5,2);
  message        : String(200);
}

/**
 * Cache plane — how long an answer may be reused before the question goes back
 * to S/4 and the model.
 *
 * Its own service because it is its own job: someone tuning freshness against
 * cost should not thereby be able to change quotas or read the audit trail.
 * A client that does not want caching can leave every policy inactive and the
 * runtime simply never caches.
 */
@path    : '/odata/cache'
@requires: 'authenticated-user'
service CacheService {

  @restrict: [
    { grant: ['READ'], to: ['CacheRead', 'CacheMaintain', 'ConfigRead'] },
    { grant: ['*'],    to: ['CacheMaintain'] }
  ]
  @odata.draft.enabled
  entity CachePolicies as projection on db.CachePolicy;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['CacheRead', 'CacheMaintain', 'DashboardAdmin'] }]
  entity CacheStats as projection on db.CacheStat {
    *,
    virtual null as hitRatio : Decimal(5,2)
  };

  /** Drop cached answers for one business object, or all of them. */
  @requires: 'CacheMaintain'
  action purge(objectCode : String(30)) returns PurgeResult;

  /** Which backend is live, and is the current TTL actually producing hits? */
  @restrict: [{ grant: ['READ'], to: ['CacheRead', 'CacheMaintain', 'DashboardAdmin'] }]
  function health() returns CacheHealth;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['CacheRead', 'CacheMaintain', 'DashboardAdmin'] }]
  view EffectivenessByObject as
    select from db.CacheStat {
      key objectCode,
          sum(hits)        as hits        : Integer,
          sum(misses)      as misses      : Integer,
          sum(writes)      as writes      : Integer,
          sum(tokensSaved) as tokensSaved : Integer
    }
    group by objectCode;
}
