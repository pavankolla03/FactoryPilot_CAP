using { factorypilot.token as db } from '../db/token';

type QuotaDecision {
  decision        : String(10);   // ALLOWED | DENIED
  exceededWindow  : String(10);
  reserved        : Integer;
  retryAfterEpoch : Integer;
  remainingDay    : Integer;
  remainingWeek   : Integer;
  remainingMonth  : Integer;
}

type UsageSnapshot {
  userID         : String(100);
  limitType      : String(20);
  usedDay        : Integer;
  usedWeek       : Integer;
  usedMonth      : Integer;
  limitDay       : Integer;
  limitWeek      : Integer;
  limitMonth     : Integer;
}

/**
 * Tokenisation plane: spend limits, spend records, and model routing.
 *
 * Its own service because it gates cost. Everyone may read their own usage;
 * changing a limit is privileged and separately scoped.
 */
@path    : '/odata/token'
@requires: 'authenticated-user'
service TokenService {

  @restrict: [
    { grant: ['READ'], to: ['TokenRead', 'TokenMaintain', 'DashboardAdmin'] },
    { grant: ['*'],    to: ['TokenMaintain'] }
  ]
  @odata.draft.enabled
  entity QuotaPolicies as projection on db.QuotaPolicy;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['TokenRead', 'TokenMaintain', 'DashboardAdmin'] }]
  entity Consumptions as projection on db.Consumption;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['TokenRead', 'TokenMaintain', 'DashboardAdmin'] }]
  entity TokenUsages as projection on db.TokenUsage;

  @restrict: [
    { grant: ['READ'], to: ['TokenRead', 'TokenMaintain'] },
    { grant: ['*'],    to: ['TokenMaintain'] }
  ]
  @odata.draft.enabled
  entity ModelRoutes as projection on db.ModelRoute;

  @restrict: [
    { grant: ['READ'], to: ['TokenMaintain'] },
    { grant: ['*'],    to: ['TokenMaintain'] }
  ]
  @odata.draft.enabled
  entity ApiKeyRefs as projection on db.ApiKeyRef;

  /**
   * Atomic check-and-reserve. Callers get a decision, not a number to compare
   * themselves — that is what stops two concurrent requests both passing the
   * same limit.
   */
  @requires: 'InsightsQuery'
  action checkAndReserve(subject : String(100), estimatedTokens : Integer) returns QuotaDecision;

  /** Settle the reservation against what the model actually charged. */
  @requires: 'InsightsQuery'
  action reconcile(subject : String(100), reserved : Integer, actualTokens : Integer) returns Boolean;

  /** Any authenticated user may read their own consumption. */
  function myUsage() returns UsageSnapshot;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['TokenRead', 'TokenMaintain', 'DashboardAdmin'] }]
  view SpendByModel as
    select from db.TokenUsage {
      key model,
          provider,
          count(*)            as calls        : Integer,
          sum(totalTokens)    as totalTokens  : Integer,
          avg(latencyMs)      as avgLatencyMs : Integer
    }
    group by model, provider;
}
