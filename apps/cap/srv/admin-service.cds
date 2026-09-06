using { factorypilot.admin as db } from '../db/admin';

/** One remembered preference, and what happened to it. */
type PreferenceResult {
  prefKey   : String(40);
  prefValue : String(100);
  cleared   : Boolean;
  message   : String(300);
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
}
