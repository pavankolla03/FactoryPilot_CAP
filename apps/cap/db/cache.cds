namespace factorypilot.cache;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag } from './common';

/**
 * Cache policy — the admin-facing control over how long an answer may be
 * reused before the question goes back to S/4 and the model.
 *
 * Matched most-specific-first: an entry naming a queryPattern beats one that
 * only names the objectCode, which beats the DEFAULT row. That lets "how many
 * today" expire in minutes while a slower-moving question caches for hours,
 * without either needing code.
 */
@assert.unique: { scopeKey: [ objectCode, queryPattern ] }
entity CachePolicy : cuid, managed, ActiveFlag {
  @title: 'Object Code'
  objectCode       : String(30) not null default 'DEFAULT';

  @title: 'Query Pattern'
  queryPattern     : String(200);

  @title: 'Caching Enabled'
  cacheEnabled     : Boolean default true;

  @title: 'TTL Value'
  ttlValue         : Integer default 15;

  @title: 'TTL Unit'
  ttlUnit          : String(10) default 'MINUTES';    // MINUTES | HOURS | DAYS

  /**
   * PER_USER  — a user only ever sees answers computed for them
   * PER_ROLE  — users holding the same roles share one entry
   * GLOBAL    — everyone shares
   *
   * This is a data-visibility decision, not just a performance one: GLOBAL on a
   * warehouse-scoped question would serve one plant's numbers to another.
   */
  @title: 'Key Scope'
  cacheKeyStrategy : String(10) default 'PER_USER';

  /**
   * A "today" answer must not outlive today. With this on, TTL is capped at
   * the seconds remaining until local midnight, so a 15-minute entry written
   * at 23:58 expires in 2 minutes rather than reporting yesterday's figures
   * as this morning's (ADR-010).
   */
  @title: 'Expire at Midnight for Today Queries'
  midnightClamp    : Boolean default true;

  @title: 'Description'
  description      : String(200);
}

/**
 * Per-policy counters. Without these an admin has no way to tell a TTL that is
 * working from one that is too short to ever hit.
 */
entity CacheStat : cuid {
  @title: 'Object Code'
  objectCode   : String(30);

  @title: 'Day'
  day          : Date;

  @title: 'Hits'
  hits         : Integer default 0;

  @title: 'Misses'
  misses       : Integer default 0;

  @title: 'Writes'
  writes       : Integer default 0;

  @title: 'Tokens Saved'
  tokensSaved  : Integer default 0;

  @title: 'Last Updated'
  lastUpdated  : Timestamp;
}
