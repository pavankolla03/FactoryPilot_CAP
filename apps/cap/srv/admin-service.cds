using { factorypilot.admin as db } from '../db/admin';

/** One remembered preference, and what happened to it. */
type PreferenceResult {
  prefKey   : String(40);
  prefValue : String(100);
  cleared   : Boolean;
  message   : String(300);
}

/** One thing an operator can configure, and whether it is configured. */
type ConfigCheck {
  area    : String(40);
  name    : String(80);
  status  : String(10);   // ok | warn | missing | error
  detail  : String(500);
  fix     : String(500);
  envVars : String(300);
}

/** One backend, asked whether it will actually answer. */
type ProbeResult {
  name      : String(120);
  kind      : String(30);
  status    : String(10);
  detail    : String(600);
  elapsedMs : Integer;
}

type EffectivePolicy {
  autoApproveReads      : Boolean;
  autoApproveWrites     : Boolean;
  writeCeiling          : Integer;
  requireSecondApprover : Boolean;
  decidedBy             : String(200);
}

/**
 * Identity, authorisation and autonomy.
 *
 * Distinct from Config: this decides who may do what and how far the agent may
 * act unattended. Wiring it into the same service as OData registration would
 * mean one scope grants both.
 */
@path    : '/odata/admin'
@requires: 'authenticated-user'
service AdminService {

  @restrict: [
    { grant: ['READ'], to: ['AdminRead', 'AdminMaintain'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]
  @odata.draft.enabled
  entity Users as projection on db.User;

  @restrict: [
    { grant: ['READ'], to: ['AdminRead', 'AdminMaintain'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]  entity UserScopes as projection on db.UserScope;

  @restrict: [
    { grant: ['READ'], to: ['AdminRead', 'AdminMaintain'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]
  @odata.draft.enabled
  entity ApprovalPolicies as projection on db.ApprovalPolicy;

  @restrict: [
    { grant: ['READ'], to: ['AdminRead', 'AdminMaintain'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]
  @odata.draft.enabled
  entity OrgSettings as projection on db.OrgSettings;

  /**
   * Resolve USER, WAREHOUSE and ORG policies into the one that applies.
   * Most restrictive wins — a permissive user policy cannot widen what the
   * warehouse allows.
   */
  function effectivePolicy(userID : String(100), warehouseID : String(20)) returns EffectivePolicy;

  /** Does this user hold write access on this warehouse? */
  function canWrite(userID : String(100), warehouseID : String(20)) returns Boolean;

  /**
   * Remember how this person works. (BETA)
   *
   * Structured preferences only, from an allowlisted key set — never free
   * text. Anything a user can store, they can use to instruct the model, and
   * the system prompt is where grounding and write-refusal live. A preference
   * flows through paths that already exist rather than becoming a sentence in
   * a prompt.
   *
   * Scoped to the caller: `$user` decides whose preference is written, not a
   * parameter, so one user cannot set another's default plant.
   */
  @requires: 'InsightsQuery'
  action setPreference(prefKey : String(40), prefValue : String(100)) returns PreferenceResult;

  /** What this caller has told us. Their own only. */
  @requires: 'InsightsQuery'
  function myPreferences() returns many PreferenceResult;

  /**
   * What is configured and what is missing. Reads environment and bindings
   * only — no network, so it answers immediately.
   *
   * Admin-only: the list names every environment variable this deployment
   * reads, which is a map of where its secrets live even though no value is
   * ever returned.
   */
  @requires: 'AdminRead'
  function configHealth() returns many ConfigCheck;

  /**
   * Ask each configured backend whether it actually answers, using the same
   * path and credential the agent would. Makes real network calls, so it is a
   * separate call the page fires after it has painted.
   */
  @requires: 'AdminMaintain'
  function probeConnections() returns many ProbeResult;
}
