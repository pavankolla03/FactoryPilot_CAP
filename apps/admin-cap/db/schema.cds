namespace factorypilot;

using { managed, cuid } from '@sap/cds/common';

// ---------------------------------------------------------------------------
// Enumerations (mirror Component_Contracts.md section 3)
// ---------------------------------------------------------------------------

type LimitType        : String(20) enum { REQUEST_COUNT; TOKEN_COUNT };
type OveragePolicy    : String(20) enum { BLOCK; WARN_AND_ALLOW; QUEUE };
type PeriodType       : String(10) enum { DAY; WEEK; MONTH };
type TtlUnit          : String(10) enum { MINUTES; HOURS; DAYS };
type CacheKeyStrategy : String(10) enum { PER_USER; PER_ROLE; GLOBAL };
type CacheResult      : String(20) enum { HIT; MISS; NOT_APPLICABLE };
type RateLimitResult  : String(10) enum { ALLOWED; DENIED };
type LogStatus        : String(20) enum { SUCCESS; RATE_LIMITED; ERROR };

// ---------------------------------------------------------------------------
// The OData / business object registry.
//
// Adding a business object — or a whole new module — is a row here. It is never
// a new iFlow and never a code deploy (ADR-016).
// ---------------------------------------------------------------------------

@assert.unique: { objectCode: [ objectCode ] }
entity BusinessObjectConfig : cuid, managed {
  @title: 'Object Code'
  objectCode            : String(30) not null;

  @title: 'Object Name'
  objectName            : String(60);

  @title: 'Module Domain'
  moduleDomain          : String(30) default 'SCM';

  @title: 'Intent Keywords'
  keywords              : String(500);

  @title: 'BTP Destination'
  destinationName       : String(100);

  @title: 'OData Service Path'
  odataServicePath      : String(200);

  @title: 'Entity Set'
  entitySet             : String(100);

  @title: 'OData Version'
  apiVersion            : String(10) default 'v2';

  @title: 'Default Filters'
  defaultFilters        : String(500);

  @title: 'Select Fields'
  selectFields          : String(500);

  @title: 'Prompt Hints'
  promptHints           : String(1000);

  @title: 'Hub API Name'
  hubApiName            : String(100);

  @title: 'Hub API URL'
  hubApiUrl             : String(300);

  @title: 'Communication Scenario'
  communicationScenario : String(30);

  @title: 'Active'
  isActive              : Boolean default false;
}

// ---------------------------------------------------------------------------
// Rate limiting: policy and durable counters.
//
// Redis holds the hot counters; these rows are the durable record the dashboard
// reads and the orchestrator reconciles into after each LLM call (ADR-009).
// ---------------------------------------------------------------------------

entity UserRateLimitConfig : cuid, managed {
  @title: 'User / Role / DEFAULT'
  userID        : String(100) not null;

  @title: 'Daily Limit'
  dailyLimit    : Integer;

  @title: 'Weekly Limit'
  weeklyLimit   : Integer;

  @title: 'Monthly Limit'
  monthlyLimit  : Integer;

  @title: 'Limit Type'
  limitType     : LimitType default #REQUEST_COUNT;

  @title: 'Overage Policy'
  overagePolicy : OveragePolicy default #BLOCK;

  @title: 'Active'
  isActive      : Boolean default true;
}

entity UserConsumption : cuid {
  @title: 'User'
  userID        : String(100) not null;

  @title: 'Period Type'
  periodType    : PeriodType not null;

  @title: 'Period Start'
  periodStart   : Date not null;

  @title: 'Consumed'
  consumedCount : Integer default 0;

  @title: 'Last Updated'
  lastUpdated   : Timestamp;
}

// ---------------------------------------------------------------------------
// Cache policy per business object / query pattern.
// ---------------------------------------------------------------------------

entity CacheConfig : cuid, managed {
  @title: 'Object Code'
  objectCode       : String(30) not null;

  @title: 'Query Pattern'
  queryPattern     : String(200);

  @title: 'Cache Enabled'
  cacheEnabled     : Boolean default true;

  @title: 'TTL Value'
  ttlValue         : Integer default 15;

  @title: 'TTL Unit'
  ttlUnit          : TtlUnit default #MINUTES;

  @title: 'Key Strategy'
  cacheKeyStrategy : CacheKeyStrategy default #PER_USER;

  @title: 'Active'
  isActive         : Boolean default true;
}

// ---------------------------------------------------------------------------
// Audit trail. Exactly one row per request, whatever the outcome — cache hit,
// success, rate-limited, or error. Written by the orchestrator.
// ---------------------------------------------------------------------------

entity CommunicationLog : cuid {
  @title: 'Timestamp'
  timestamp            : Timestamp;

  @title: 'User'
  userID               : String(100);

  @title: 'Channel'
  channel              : String(40);

  @title: 'Object Code'
  objectCode           : String(30);

  @title: 'Question'
  userQuery            : String(1000);

  @title: 'OData URL'
  odataURLCalled       : String(500);

  @title: 'OData Time (ms)'
  odataResponseTimeMs  : Integer;

  @title: 'Cache Result'
  cacheResult          : CacheResult;

  @title: 'Rate Limit Result'
  rateLimitResult      : RateLimitResult;

  @title: 'LLM Provider'
  llmProvider          : String(100);

  @title: 'LLM Model'
  llmModel             : String(100);

  @title: 'Tokens Used'
  tokensUsed           : Integer;

  @title: 'Total Time (ms)'
  totalResponseTimeMs  : Integer;

  @title: 'Status'
  status               : LogStatus;

  @title: 'Response Summary'
  responseSummary      : String(2000);

  @title: 'Error Detail'
  errorDetail          : String(1000);

  @title: 'Correlation ID'
  correlationId        : String(60);
}
