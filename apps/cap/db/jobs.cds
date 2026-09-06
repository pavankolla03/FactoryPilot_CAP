namespace factorypilot.jobs;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag, factorypilot.common.RunStatus } from './common';

/*
 * Background work — the part of the product that acts without being asked.
 *
 * Everything else in this application is reactive: a person types a question
 * and a request answers it. These entities are what lets it notice something
 * on its own, which is the whole distinction between an assistant and an agent.
 *
 * BETA. New surface, and it writes nothing to S/4 — the first jobs read, judge
 * and notify. Anything that would act stays behind the existing approval gate.
 *
 * Plain block comment, not a doc comment: a `/**` here binds to the entity
 * that follows and CDS warns that it overwrites that entity's own.
 */

/**
 * One row per job, and the lock that stops it running more than once.
 *
 * Cloud Foundry runs several instances of the same application. A plain timer
 * fires in every one of them, so a daily digest would go out three times and a
 * threshold alert would page someone in triplicate. Correctness here is not a
 * detail of the digest — it is the reason this table exists at all.
 *
 * The lock is a lease, not a flag: an instance claims the job until
 * `lockedUntil`, and an instance that dies mid-run simply stops renewing, so
 * the lease expires and another picks the job up. A boolean `isRunning` would
 * have jammed permanently the first time a container was recycled mid-job.
 */
entity ScheduledJob : cuid, managed, ActiveFlag {
  /** Stable identifier the code refers to: 'daily-digest', 'threshold-sweep'. */
  @title: 'Job Name'
  @assert.unique
  jobName       : String(60) not null;

  @title: 'Description'
  description   : String(200);

  /** Minutes between runs. Deliberately not cron: every job here is "every N
   *  minutes" or "once a day at hour H", and a cron parser is a dependency and
   *  a class of bug for expressiveness nothing yet needs. */
  @title: 'Interval (minutes)'
  intervalMinutes : Integer default 60;

  /** For daily jobs: the local hour to run at. Null means use the interval. */
  @title: 'Run At Hour'
  runAtHour     : Integer;

  @title: 'Last Run At'
  lastRunAt     : Timestamp;

  @title: 'Last Run Status'
  lastRunStatus : RunStatus;

  @title: 'Last Run Message'
  lastRunMessage : String(500);

  @title: 'Last Run Duration (ms)'
  lastRunMs     : Integer;

  @title: 'Consecutive Failures'
  failureCount  : Integer default 0;

  // --- the lease ---------------------------------------------------------

  /** Which instance holds the job, for the log. Never used to decide
   *  anything — only `lockedUntil` gates the run. */
  @title: 'Locked By'
  lockedBy      : String(80);

  @title: 'Locked Until'
  lockedUntil   : Timestamp;
}

/**
 * What a run actually did, kept whether or not it succeeded.
 *
 * The digest is the first thing in this product that speaks without being
 * spoken to, so "did it go out, to whom, and what did it say" has to be
 * answerable after the fact — the same reason every question already leaves an
 * audit row.
 */
entity JobRun : cuid {
  @title: 'Job Name'
  jobName     : String(60) not null;

  @title: 'Started At'
  startedAt   : Timestamp;

  @title: 'Finished At'
  finishedAt  : Timestamp;

  @title: 'Duration (ms)'
  durationMs  : Integer;

  @title: 'Status'
  status      : RunStatus;

  @title: 'Instance'
  instance    : String(80);

  /** Human-readable outcome: '3 alerts sent', 'nothing to report'. */
  @title: 'Summary'
  summary     : String(1000);

  @title: 'Error Detail'
  errorDetail : String(2000);
}

/**
 * A standing question. (BETA)
 *
 * "Tell me if stock of P123 in plant 1710 drops below 500." Today that is a
 * question someone has to remember to ask; a watcher is the same question
 * asked once and answered forever, which is most of what separates a tool you
 * open from a system that works for you.
 *
 * The important field is `lastBreached`. A watcher is evaluated on a schedule,
 * so a condition that stays true is true at every sweep — and notifying every
 * time would turn a useful alert into noise that gets filtered within a day.
 * Alerts fire on the *transition* into breach, and again only after the
 * condition has cleared and returned. That is the difference between an alert
 * someone acts on and one they mute.
 */
entity Watcher : cuid, managed, ActiveFlag {
  @title: 'Name'
  name          : String(120) not null;

  /** Which registered business object to read — MATERIAL_STOCK and so on. */
  @title: 'Business Object'
  objectCode    : String(30) not null;

  @title: 'Plant / Warehouse'
  warehouseID   : String(20);

  /** Free-text narrowing, passed to the same filter builder the agent uses,
   *  so a watcher can express anything a question can. */
  @title: 'Filter'
  filterText    : String(200);

  /**
   * What is being watched.
   *
   * ROW_COUNT needs no field and covers most of what people actually ask for
   * — "tell me when there are open counts", "when any PO is overdue". A field
   * comparison is the finer case.
   */
  @title: 'Measure'
  measure       : String(20) default 'ROW_COUNT';   // ROW_COUNT | FIELD_MIN | FIELD_MAX | FIELD_SUM

  @title: 'Field'
  fieldName     : String(60);

  @title: 'Comparison'
  comparison    : String(10) default 'LT';          // LT | LTE | GT | GTE | EQ | NE

  @title: 'Threshold'
  threshold     : Decimal(15,3);

  @title: 'Owner'
  owner         : String(120);

  // --- state, so an alert fires on the edge rather than on every sweep ----

  @title: 'Currently Breached'
  lastBreached  : Boolean default false;

  @title: 'Last Value'
  lastValue     : Decimal(15,3);

  @title: 'Last Checked'
  lastCheckedAt : Timestamp;

  @title: 'Last Alerted'
  lastAlertedAt : Timestamp;

  @title: 'Times Alerted'
  alertCount    : Integer default 0;

  @title: 'Last Error'
  lastError     : String(300);
}

/**
 * What a business object looked like, recorded over time. (BETA)
 *
 * A watcher catches what you thought to threshold. This catches what you did
 * not: "stock in 1710 is a third of what it has been all week" is worth
 * knowing even though nobody set 500 as a line, and it is exactly the kind of
 * thing nobody sets a line for until after it has bitten them once.
 *
 * Only a count and a timestamp — deliberately not the rows themselves. The
 * point is the shape of the series, and keeping the data would make this a
 * second copy of S/4 that ages badly and has to be governed.
 */
entity Observation : cuid {
  @title: 'Business Object'
  objectCode  : String(30) not null;

  @title: 'Plant / Warehouse'
  warehouseID : String(20);

  @title: 'Observed At'
  observedAt  : Timestamp;

  @title: 'Row Count'
  rowCount    : Integer;

  /** Whether this observation was itself judged anomalous, so the history
   *  shows when the series broke as well as what it was. */
  @title: 'Flagged'
  flagged     : Boolean default false;

  @title: 'Reason'
  reason      : String(300);
}

/**
 * A question that is allowed to take minutes. (BETA)
 *
 * Every question today is bounded by `ASK_BUDGET_MS` — about 75 seconds —
 * because the browser is waiting and the gateway gives up at two minutes. That
 * ceiling is right for a chat box and wrong for the questions Tier 2 made
 * possible: a root-cause chain across a month of movements is legitimately
 * slow, and the honest answer to it today is "that took longer than I am
 * allowed to spend".
 *
 * So the work moves off the request. The question is queued, a background
 * worker runs it with a far larger budget, and the answer is collected later.
 * Nothing about *how* it is answered changes — the same agent, tools, quota
 * and audit — only how long it is allowed to take and who is waiting.
 *
 * Deliberately not a general job queue. It holds questions, it is read by one
 * worker, and a run that dies mid-flight is visible as RUNNING with a start
 * time rather than lost.
 */
entity AsyncRun : cuid {
  @title: 'User'
  userID         : String(100) not null;

  @title: 'Conversation'
  conversationID : UUID;

  @title: 'Question'
  question       : String(2000) not null;

  @title: 'Plant / Warehouse'
  warehouseID    : String(20);

  @title: 'Status'
  status         : String(20) default 'QUEUED';   // QUEUED | RUNNING | SUCCESS | FAILED | EXPIRED

  /** What it is doing right now, in words a waiting person can read. */
  @title: 'Progress'
  progress       : String(200);

  @title: 'Answer'
  answer         : LargeString;

  @title: 'Error Detail'
  errorDetail    : String(2000);

  @title: 'Grounded'
  grounded       : Boolean default false;

  @title: 'Rounds Used'
  rounds         : Integer;

  @title: 'Tokens Used'
  tokensUsed     : Integer;

  @title: 'Queued At'
  queuedAt       : Timestamp;

  @title: 'Started At'
  startedAt      : Timestamp;

  @title: 'Finished At'
  finishedAt     : Timestamp;

  @title: 'Correlation Id'
  correlationId  : String(60);

  /** Tokens reserved at submit, so the worker can reconcile what was actually
   *  spent. Without this an async question would escape the quota that every
   *  synchronous one obeys. */
  @title: 'Quota Reserved'
  quotaReserved  : Integer default 0;
}
