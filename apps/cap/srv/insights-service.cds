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

type ChatResult {
  status        : String(20);   // SUCCESS | RATE_LIMITED | AWAITING_APPROVAL | ERROR
  answer        : String(4000);
  metrics       : LargeString;
  errorCode     : String(40);
  message       : String(500);
  pendingAction : PendingActionCard;
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
