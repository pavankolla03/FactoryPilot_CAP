using { factorypilot.audit as audit } from '../db/audit';
using { factorypilot.token as token } from '../db/token';
using { factorypilot.cache as cache } from '../db/cache';

type Overview {
  requestsToday      : Integer;
  requestsTotal      : Integer;
  tokensToday        : Integer;
  tokensTotal        : Integer;
  cacheHitRatio      : Decimal(5,2);
  groundedRatio      : Decimal(5,2);
  quotaDenials       : Integer;
  failures           : Integer;
  pendingApprovals   : Integer;
  avgResponseMs      : Integer;
  activeUsers        : Integer;
  activeObjects      : Integer;
}

type QuotaHeadroom {
  userID       : String(100);
  limitType    : String(20);
  usedDay      : Integer;
  limitDay     : Integer;
  percentUsed  : Decimal(5,2);
  atRisk       : Boolean;
}

/**
 * Monitoring plane — Component 7 of the requirements.
 *
 * Read-only and aggregate-only. It owns no data of its own; it reads what the
 * audit, token and cache planes already record, which is why it can be handed
 * to someone who should see how the platform is behaving without being able to
 * change anything about it.
 */
@path    : '/odata/dashboard'
@requires: 'authenticated-user'
@readonly
service DashboardService {

  /** The tile row: everything a first glance should answer. */
  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  function overview() returns Overview;

  /**
   * Who is close to their limit. The point is to spot a user about to be
   * blocked *before* they are, rather than explaining it afterwards.
   */
  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'TokenRead'] }]
  function quotaHeadroom() returns array of QuotaHeadroom;

  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view VolumeByDay as
    select from audit.SessionLog {
      key cast(timestamp as Date) as day : Date,
          count(*)                       as requests   : Integer,
          sum(tokensUsed)                as tokens     : Integer,
          sum(case when status = 'FAILED'       then 1 else 0 end) as failures : Integer,
          sum(case when quotaResult = 'DENIED'  then 1 else 0 end) as denied   : Integer,
          sum(case when cacheResult = 'HIT'     then 1 else 0 end) as cacheHits : Integer
    }
    group by cast(timestamp as Date);

  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view ByUser as
    select from audit.SessionLog {
      key userID,
          count(*)        as requests   : Integer,
          sum(tokensUsed) as tokens     : Integer,
          sum(case when quotaResult = 'DENIED' then 1 else 0 end) as denied   : Integer,
          sum(case when grounded = true        then 1 else 0 end) as grounded : Integer,
          max(totalResponseTimeMs)               as slowestMs : Integer
    }
    group by userID;

  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view ByObject as
    select from audit.SessionLog {
      key objectCode,
          count(*)        as requests  : Integer,
          sum(tokensUsed) as tokens    : Integer,
          sum(case when cacheResult = 'HIT' then 1 else 0 end) as cacheHits : Integer,
          sum(case when grounded = true     then 1 else 0 end) as grounded  : Integer,
          avg(totalResponseTimeMs)          as avgMs     : Integer
    }
    group by objectCode;

  /**
   * Where the time actually goes. Splitting backend time from total is what
   * tells you whether a slow answer is S/4 or the model — the two have
   * completely different fixes.
   */
  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view LatencySplit as
    select from audit.SessionLog {
      key objectCode,
          count(*)               as samples     : Integer,
          avg(backendTimeMs)     as avgBackendMs : Integer,
          avg(totalResponseTimeMs) as avgTotalMs : Integer
    }
    group by objectCode;

  /** What people actually ask — the raw material for keyword and prompt tuning. */
  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view TopQuestions as
    select from audit.SessionLog {
      key userQuery,
          count(*)        as asked  : Integer,
          sum(tokensUsed) as tokens : Integer
    }
    group by userQuery;

  /** Failures grouped so a recurring one stands out from a one-off. */
  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'AuditRead'] }]
  view Failures as
    select from audit.SessionLog {
      key errorDetail,
          count(*)   as occurrences : Integer,
          max(timestamp) as lastSeen : Timestamp
    }
    where status = 'FAILED'
    group by errorDetail;

  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'TokenRead'] }]
  view SpendByModel as
    select from token.TokenUsage {
      key model,
          provider,
          count(*)         as calls      : Integer,
          sum(totalTokens) as tokens     : Integer,
          avg(latencyMs)   as avgMs      : Integer,
          sum(case when isEstimated = true then 1 else 0 end) as estimated : Integer
    }
    group by model, provider;

  @restrict: [{ grant: ['READ'], to: ['DashboardRead', 'DashboardAdmin', 'CacheRead'] }]
  view CacheEffectiveness as
    select from cache.CacheStat {
      key objectCode,
          sum(hits)        as hits        : Integer,
          sum(misses)      as misses      : Integer,
          sum(tokensSaved) as tokensSaved : Integer
    }
    group by objectCode;
}
