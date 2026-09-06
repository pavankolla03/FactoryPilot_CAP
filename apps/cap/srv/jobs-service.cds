using { factorypilot.jobs as db } from '../db/jobs';

type JobTriggerResult {
  jobName  : String(60);
  status   : String(20);
  summary  : String(1000);
  ranMs    : Integer;
}

type ExportFile {
  name      : String(40);
  title     : String(120);
  filename  : String(120);
  rowCount  : Integer;
  days      : Integer;
  csv       : LargeString;
}

type DigestPreview {
  text        : String(8000);
  sections    : Integer;
  unreadable  : Integer;
  generatedAt : Timestamp;
}

/**
 * Background work — the jobs that run without anyone asking. (BETA)
 *
 * Its own service for the same reason the others are: someone who should be
 * able to pause the overnight digest should not thereby be able to change
 * quotas or read the audit trail.
 *
 * The lease columns are deliberately exposed read-only rather than hidden.
 * "Why did the digest not go out?" is answered by seeing which instance holds
 * the job and until when, and hiding that would leave an operator guessing at
 * the one mechanism that decides whether a job runs at all.
 */
@path    : '/odata/jobs'
@requires: 'authenticated-user'
service JobsService {

  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'AdminRead', 'AdminMaintain', 'DashboardAdmin'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]
  @odata.draft.enabled
  entity ScheduledJobs as projection on db.ScheduledJob {
    *,
    /**
     * Red for a failed last run, green for a good one, so a job that broke
     * overnight is visible in a scan of the list rather than found by reading
     * every row. (3 positive, 1 negative, 0 neutral in Fiori's scale.)
     *
     * Calculated here rather than filled in by an after-READ handler: a client
     * asking for `$select=lastRunCriticality` without `lastRunStatus` left the
     * handler computing from a field that was not there, and every row came
     * back neutral — the failed ones included, which is precisely the case this
     * column exists to make visible. Expressed in the projection, the database
     * evaluates it and `$select` cannot take its input away.
     */
    case when lastRunStatus = 'FAILED'  then 1
         when lastRunStatus = 'SUCCESS' then 3
         else 0
    end as lastRunCriticality : Integer
  };

  @readonly
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'AdminRead', 'AdminMaintain', 'DashboardAdmin'] }]
  entity JobRuns as projection on db.JobRun;

  /**
   * Standing questions — "tell me if stock drops below 500". (BETA)
   *
   * The state columns are exposed read-only rather than hidden: whether a
   * watcher is *currently* breached is the difference between "it has not
   * alerted because all is well" and "it has not alerted because it already
   * did", and someone looking at this screen needs to tell those apart.
   */
  @restrict: [
    { grant: ['READ'], to: ['ConfigRead', 'AdminRead', 'AdminMaintain', 'DashboardAdmin'] },
    { grant: ['*'],    to: ['AdminMaintain'] }
  ]
  @odata.draft.enabled
  entity Watchers as projection on db.Watcher {
    *,
    /** Red while breached, green when clear — so a list scan finds the ones
     *  that need attention. */
    case when lastBreached = true then 1 else 3 end as breachCriticality : Integer
  };

  /**
   * Run a job now, without waiting for its schedule.
   *
   * The point is being able to see what the digest would say before trusting
   * it to a 6am delivery. It takes the same lease as a scheduled run, so
   * pressing it twice — or pressing it while the scheduled run is in flight —
   * cannot produce two concurrent runs.
   */
  @requires: 'AdminMaintain'
  action runNow(jobName : String(60)) returns JobTriggerResult;

  /**
   * Build the digest and return it without delivering it anywhere.
   *
   * Separate from runNow because "show me what it would say" and "send it"
   * are different intentions, and conflating them means the only way to
   * preview is to notify everyone.
   */
  @restrict: [{ grant: ['READ'], to: ['AdminRead', 'AdminMaintain', 'DashboardAdmin'] }]
  function previewDigest() returns DigestPreview;

  /**
   * Build one report now and return it as CSV. (BETA)
   *
   * Separate from the scheduled job for the same reason `previewDigest` is:
   * "let me see it" and "send it to everyone" are different intentions, and
   * conflating them means the only way to check a report is to mail it out.
   */
  @restrict: [{ grant: ['READ'], to: ['AuditRead', 'AdminRead', 'AdminMaintain', 'DashboardAdmin'] }]
  function exportReport(name : String(40), days : Integer) returns ExportFile;
}
