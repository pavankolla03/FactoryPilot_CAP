namespace factorypilot.audit;

using { cuid } from '@sap/cds/common';
using { factorypilot.common.RunStatus } from './common';

/**
 * One row per request, whatever the outcome — cached, answered, denied or
 * failed. The auditability NFR depends on there being no path that skips this.
 */
entity SessionLog : cuid {
  @title: 'Timestamp'
  timestamp            : Timestamp;

  @title: 'User'
  userID               : String(100);

  @title: 'Channel'
  channel              : String(40);

  @title: 'Conversation'
  conversationID       : UUID;

  @title: 'Object Code'
  objectCode           : String(30);

  @title: 'Question'
  userQuery            : String(1000);

  @title: 'Tools Called'
  toolsCalled          : String(500);

  @title: 'Backend URL'
  backendUrlCalled     : String(500);

  @title: 'Backend Time (ms)'
  backendTimeMs        : Integer;

  @title: 'Cache'
  cacheResult          : String(20);   // HIT | MISS | NOT_APPLICABLE

  @title: 'Quota'
  quotaResult          : String(10);   // ALLOWED | DENIED

  @title: 'Provider'
  llmProvider          : String(100);

  @title: 'Model'
  llmModel             : String(100);

  @title: 'Tokens'
  tokensUsed           : Integer;

  @title: 'Total (ms)'
  totalResponseTimeMs  : Integer;

  @title: 'Status'
  status               : RunStatus;

  /** Whether the answer was derived from tool output rather than model recall.
   *  An ungrounded answer is not necessarily wrong, but it is not evidence. */
  @title: 'Grounded'
  grounded             : Boolean default false;

  @title: 'Response Summary'
  responseSummary      : String(2000);

  @title: 'Error Detail'
  errorDetail          : String(1000);

  @title: 'Correlation ID'
  correlationId        : String(60);
}

/** An agent turn: the tool rounds it took and what it decided. */
entity AgentRun : cuid {
  @title: 'Started'
  startedAt      : Timestamp;

  @title: 'Finished'
  finishedAt     : Timestamp;

  @title: 'User'
  userID         : String(100);

  @title: 'Conversation'
  conversationID : UUID;

  @title: 'Goal'
  goal           : String(500);

  @title: 'Rounds'
  rounds         : Integer default 0;

  @title: 'Tool Calls'
  toolCallCount  : Integer default 0;

  @title: 'Status'
  status         : RunStatus;

  @title: 'Outcome'
  outcome        : String(2000);

  steps          : Composition of many AgentStep on steps.run = $self;
}

entity AgentStep : cuid {
  run        : Association to AgentRun;

  @title: 'Sequence'
  seq        : Integer;

  @title: 'Tool'
  toolName   : String(60);

  @title: 'Arguments'
  arguments  : LargeString;

  @title: 'Result'
  result     : LargeString;

  @title: 'Duration (ms)'
  durationMs : Integer;

  @title: 'Error'
  error      : String(1000);
}

/**
 * A write the agent proposed but did not perform.
 *
 * Nothing that mutates a backend runs without passing through here first —
 * either a human approves it, or an approval policy auto-approves it and the
 * row records that it did.
 */
entity PendingAction : cuid {
  @title: 'Created'
  createdAt      : Timestamp;

  @title: 'Expires'
  expiresAt      : Timestamp;

  @title: 'User'
  userID         : String(100);

  @title: 'Conversation'
  conversationID : UUID;

  @title: 'Tool'
  toolName       : String(60);

  @title: 'Arguments'
  arguments      : LargeString;

  @title: 'Warehouse'
  warehouseID    : String(20);

  @title: 'Summary'
  summary        : String(500);

  @title: 'Flagged Anomalous'
  anomalous      : Boolean default false;

  @title: 'Anomaly Reason'
  anomalyReason  : String(300);

  @title: 'Status'
  status         : String(20) default 'PENDING';  // PENDING | APPROVED | REJECTED | EXPIRED | CONSUMED

  @title: 'Approved By'
  approvedBy     : String(100);

  @title: 'Resolved At'
  resolvedAt     : Timestamp;
}

entity Feedback : cuid {
  @title: 'Timestamp'
  timestamp      : Timestamp;

  @title: 'User'
  userID         : String(100);

  @title: 'Session Log'
  sessionLogID   : UUID;

  @title: 'Rating'
  rating         : Integer;

  @title: 'Comment'
  comment        : String(1000);
}
