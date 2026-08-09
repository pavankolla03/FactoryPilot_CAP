namespace factorypilot.token;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag, factorypilot.common.LimitType, factorypilot.common.PeriodType } from './common';

/**
 * Tokenisation domain: what a user is allowed to spend, what they have spent,
 * and which model their traffic is routed to.
 *
 * Kept as its own service because it gates cost. Config and audit can be read
 * widely; changing a quota is a privileged act with its own scope.
 */
@assert.unique: { subject: [ subject ] }
entity QuotaPolicy : cuid, managed, ActiveFlag {
  /** A user id, a role name, or the literal DEFAULT fallback. */
  @title: 'User / Role / DEFAULT'
  subject       : String(100) not null;

  @title: 'Daily Limit'
  dailyLimit    : Integer;

  @title: 'Weekly Limit'
  weeklyLimit   : Integer;

  @title: 'Monthly Limit'
  monthlyLimit  : Integer;

  @title: 'Counts'
  limitType     : LimitType default #REQUEST_COUNT;

  @title: 'On Overage'
  overagePolicy : String(20) default 'BLOCK';   // BLOCK | WARN_AND_ALLOW | QUEUE

  @title: 'Per-Request Ceiling'
  perRequestMaxTokens : Integer;
}

/** Durable counters. Redis holds the hot window; these survive a flush and
 *  are what the dashboard reads. */
entity Consumption : cuid {
  @title: 'User'
  userID        : String(100) not null;

  @title: 'Period'
  periodType    : PeriodType not null;

  @title: 'Period Start'
  periodStart   : Date not null;

  @title: 'Consumed'
  consumedCount : Integer default 0;

  @title: 'Requests'
  requestCount  : Integer default 0;

  @title: 'Last Updated'
  lastUpdated   : Timestamp;
}

/** One row per LLM call — the raw material for cost reporting. */
entity TokenUsage : cuid {
  @title: 'Timestamp'
  timestamp        : Timestamp;

  @title: 'User'
  userID           : String(100);

  @title: 'Conversation'
  conversationID   : UUID;

  @title: 'Provider'
  provider         : String(40);

  @title: 'Model'
  model            : String(100);

  @title: 'Prompt Tokens'
  promptTokens     : Integer default 0;

  @title: 'Completion Tokens'
  completionTokens : Integer default 0;

  @title: 'Total Tokens'
  totalTokens      : Integer default 0;

  /** True when the provider returned no usage block and we counted locally —
   *  the number is an estimate and cost reports must say so. */
  @title: 'Estimated'
  isEstimated      : Boolean default false;

  @title: 'Route'
  route            : String(20);   // light | heavy

  @title: 'Latency (ms)'
  latencyMs        : Integer;
}

/** Which model handles which class of request. Light routing keeps simple
 *  lookups off an expensive model. */
entity ModelRoute : cuid, managed, ActiveFlag {
  @title: 'Route'
  route     : String(20) not null;  // light | heavy | intent

  @title: 'Provider'
  provider  : String(40) default 'openrouter';

  @title: 'Model'
  model     : String(100) not null;

  /** Tried in order when the primary is rate-limited or down. */
  @title: 'Fallback Models'
  fallbacks : String(500);

  @title: 'Max Tokens'
  maxTokens : Integer default 800;

  @title: 'Temperature'
  temperature : Decimal(3,2) default 0.2;
}

/** Named references to provider credentials. The secret itself never lands
 *  here — only the env var / credential-store key that holds it. */
entity ApiKeyRef : cuid, managed, ActiveFlag {
  @title: 'Label'
  label         : String(60) not null;

  @title: 'Provider'
  provider      : String(40);

  @title: 'Credential Reference'
  credentialRef : String(100) not null;

  @title: 'Last Used'
  lastUsedAt    : Timestamp;
}
