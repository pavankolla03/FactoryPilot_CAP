using { factorypilot.config as db } from '../db/config';

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
  @odata.draft.enabled
  entity BusinessObjects as projection on db.BusinessObjectConfig;



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

  /**
   * A vetted library of questions, offered rather than typed. (BETA)
   *
   * `useCount` is exposed read-only and deliberately: a library nobody runs
   * should be visible as unused rather than assumed to be helping.
   */
  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'ConfigMaintain', 'InsightsQuery'] },
    { grant: ['*'],    to: ['ConfigMaintain'] }
  ]
  @odata.draft.enabled
  entity SavedQuestions as projection on db.SavedQuestion;

  /**
   * Record that a saved question was actually asked, not just listed. (BETA)
   *
   * A separate action rather than a client-side PATCH to `useCount`: the chat
   * surface holds `InsightsQuery`, not `ConfigMaintain`, and letting a reader
   * of the library write to it directly would mean anyone who can *ask*
   * questions can also edit the count of any other row, not just bump the one
   * they used.
   */
  @requires: 'InsightsQuery'
  action useSavedQuestion(ID : UUID) returns Boolean;
}
