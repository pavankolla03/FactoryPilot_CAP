using { factorypilot.chat as db } from '../db/chat';

type ChatMetadata {
  conversationID  : UUID;
  logID           : UUID;
  runID           : UUID;
  correlationId   : String(60);
  objectCode      : String(30);
  cacheResult     : String(20);
  quotaResult     : String(10);
  tokensUsed      : Integer;
  totalResponseTimeMs : Integer;
  rounds          : Integer;
  toolsCalled     : String(500);
  grounded        : Boolean;
  provider        : String(40);
  model           : String(100);
}

type PendingActionCard {
  actionID      : UUID;
  toolName      : String(60);
  summary       : String(500);
  arguments     : LargeString;
  warehouseID   : String(20);
  anomalous     : Boolean;
  anomalyReason : String(300);
  expiresAt     : Timestamp;
}

/**
 * Several writes proposed by one question. (BETA)
 *
 * Present only when a question produced more than one write — "rebalance these
 * five materials" is one question and five moves. `flagged` is on the batch
 * rather than buried in the actions because it is what a reader checks before
 * pressing a single button that changes a real system several times.
 */
type PendingBatchCard {
  batchID   : UUID;
  count     : Integer;
  flagged   : Integer;
  actions   : many PendingActionCard;
  expiresAt : Timestamp;
}

/** What happened to each action in a batch, and to the batch as a whole. */
type BatchResult {
  batchID   : UUID;
  approved  : Integer;
  rejected  : Integer;
  failed    : Integer;
  skipped   : Integer;
  message   : String(1000);
  outcomes  : many BatchOutcome;
}

type BatchOutcome {
  actionID : UUID;
  summary  : String(500);
  status   : String(20);
  message  : String(500);
}

type AsyncSubmission {
  runID   : UUID;
  status  : String(20);
  message : String(300);
}

type AsyncStatus {
  runID       : UUID;
  status      : String(20);   // QUEUED | RUNNING | SUCCESS | FAILED | EXPIRED
  progress    : String(200);
  answer      : LargeString;
  grounded    : Boolean;
  rounds      : Integer;
  tokensUsed  : Integer;
  queuedAt    : Timestamp;
  finishedAt  : Timestamp;
  errorDetail : String(2000);
}

type ChatResult {
  status        : String(20);   // SUCCESS | RATE_LIMITED | AWAITING_APPROVAL | ERROR
  answer        : String(4000);
  metrics       : LargeString;
  errorCode     : String(40);
  message       : String(500);
  pendingAction : PendingActionCard;
  /** Null unless the question proposed more than one write. */
  pendingBatch  : PendingBatchCard;
  metadata      : ChatMetadata;
}

/**
 * The agent plane. Not CRUD — these are actions, because asking a question is
 * a command with side effects (spend, audit rows, sometimes a proposed write),
 * not an entity read.
 *
 * A write tool never executes inline. The loop stops, records a PendingAction
 * and returns a confirmation card; `confirmAction` is the only path that
 * mutates a backend, and it consumes the action exactly once.
 */
@path    : '/insights'
@requires: 'authenticated-user'
service InsightsService {

  @restrict: [{ grant: ['READ', 'CREATE', 'UPDATE'], to: ['InsightsQuery'], where: 'userID = $user' }]
  entity Conversations as projection on db.Conversation;

  @restrict: [{ grant: ['READ'], to: ['InsightsQuery'] }]
  entity Messages as projection on db.Message;

  @requires: 'InsightsQuery'
  action ask(
    question       : String(1000),
    conversationID : UUID,
    channel        : String(40),
    warehouseID    : String(20)
  ) returns ChatResult;

  /**
   * Execute a previously proposed write. One-time consumption: a replayed or
   * expired actionID returns ACTION_EXPIRED rather than running twice.
   */
  @requires: 'InsightsQuery'
  action confirmAction(actionID : UUID, approve : Boolean) returns ChatResult;

  /**
   * Decide a whole batch at once. (BETA)
   *
   * Convenience, never a relaxation: each action is still executed through the
   * same path and consumed exactly once, and a rejection rejects all of them.
   * The per-action policy checks already happened when the batch was proposed —
   * batching is a way to press one button, not a way to skip a gate.
   */
  @requires: 'InsightsQuery'
  action confirmBatch(batchID : UUID, approve : Boolean) returns BatchResult;

  /**
   * Ask a question that is allowed to take minutes. (BETA)
   *
   * Returns immediately with a run id. The answer is collected with
   * `asyncResult`. For the questions Tier 2 made possible — a root-cause chain
   * across a month of movements — where the honest synchronous answer is "that
   * took longer than I am allowed to spend".
   */
  @requires: 'InsightsQuery'
  action askAsync(question : String(2000), warehouseID : String(20), conversationID : UUID) returns AsyncSubmission;

  /** Where a queued question has got to, and its answer once there is one. */
  @requires: 'InsightsQuery'
  function asyncResult(runID : UUID) returns AsyncStatus;

  @requires: 'InsightsQuery'
  function health() returns String;

  /**
   * What the caller's token actually carries.
   *
   * Deliberately needs nothing but a valid sign-in, so it still answers when
   * `ask` is refused — which is exactly when you need it. A 403 on `ask` is
   * either a role collection that was never assigned, one that is assigned but
   * empty, or a token minted before the assignment; those look identical from
   * outside and this tells them apart.
   */
  function whoami() returns String;
}
