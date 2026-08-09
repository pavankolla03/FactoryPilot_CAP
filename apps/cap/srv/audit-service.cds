using { factorypilot.audit as db } from '../db/audit';

/**
 * Read-only history. Nothing here is writable over OData — rows are produced
 * by the insights pipeline, so an editable audit trail would not be one.
 */
@path    : '/odata/audit'
@requires: 'authenticated-user'
service AuditService {

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin'] }]
  entity SessionLogs as projection on db.SessionLog {
    *,
    // 3 green / 2 amber / 1 red, filled in by an after-READ handler.
    virtual null as statusCriticality : Integer
  };

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin'] }]
  entity AgentRuns as projection on db.AgentRun {
    *,
    virtual null as statusCriticality : Integer
  };

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin'] }]
  entity AgentSteps as projection on db.AgentStep;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin', 'InsightsQuery'] }]
  entity PendingActions as projection on db.PendingAction;

  @restrict: [
    { grant: ['READ'],   to: ['AuditRead', 'DashboardAdmin'] },
    { grant: ['CREATE'], to: ['InsightsQuery'] }
  ]
  entity Feedbacks as projection on db.Feedback;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin'] }]
  view UsageByObject as
    select from db.SessionLog {
      key objectCode,
          count(*)         as requests   : Integer,
          sum(tokensUsed)  as tokensUsed : Integer,
          sum(case when cacheResult = 'HIT'  then 1 else 0 end) as cacheHits  : Integer,
          sum(case when grounded = true      then 1 else 0 end) as grounded   : Integer,
          sum(case when status = 'FAILED'    then 1 else 0 end) as failures   : Integer
    }
    group by objectCode;

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'DashboardAdmin'] }]
  view UsageByUser as
    select from db.SessionLog {
      key userID,
          count(*)        as requests   : Integer,
          sum(tokensUsed) as tokensUsed : Integer,
          sum(case when quotaResult = 'DENIED' then 1 else 0 end) as denied : Integer
    }
    group by userID;
}
