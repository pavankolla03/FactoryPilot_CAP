namespace factorypilot.common;

/** Soft enable/disable — rows are deactivated, not deleted, so audit history
 *  keeps resolving the configuration a past request actually ran under. */
aspect ActiveFlag {
  @title: 'Active'
  isActive : Boolean default true;
}

type LimitType   : String(20) enum { REQUEST_COUNT; TOKEN_COUNT };
type PeriodType  : String(10) enum { DAY; WEEK; MONTH };
type RunStatus   : String(20) enum { RUNNING; SUCCESS; FAILED; RATE_LIMITED; AWAITING_APPROVAL };
type MessageRole : String(20) enum { system; user; assistant; tool };
