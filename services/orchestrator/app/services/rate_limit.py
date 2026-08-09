"""Per-user day/week/month rate limiting (ADR-009).

This is the product's primary control, and it lives here rather than on the
Integration Suite edge for two reasons the gateway cannot work around: a cache
hit never reaches CPI at all, and the gateway never sees LLM token counts.

Reserve-then-verify, not check-then-reserve: the counter is incremented first
and rolled back if it broke a limit, so two concurrent requests can never both
observe room under the same cap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from app.adapters.cache.base import CacheAdapter
from app.adapters.db.base import RateLimitPolicy, Repository

WINDOWS = ("DAY", "WEEK", "MONTH")


@dataclass(slots=True)
class RateLimitDecision:
    decision: str  # ALLOWED | DENIED
    exceeded_window: str | None = None
    remaining: dict[str, int] = field(default_factory=dict)
    retry_after_epoch: int | None = None
    policy: RateLimitPolicy | None = None
    reserved: int = 0


def period_start(window: str, today: date | None = None) -> date:
    today = today or date.today()
    match window:
        case "DAY":
            return today
        case "WEEK":
            return today - timedelta(days=today.weekday())
        case "MONTH":
            return today.replace(day=1)
        case _:
            raise ValueError(f"Unknown window: {window}")


def window_expiry(window: str, now: datetime | None = None) -> tuple[int, int]:
    """(ttl_seconds, epoch_at_reset) for the counter key."""
    now = now or datetime.now()
    start = period_start(window, now.date())
    match window:
        case "DAY":
            end = datetime.combine(start + timedelta(days=1), datetime.min.time())
        case "WEEK":
            end = datetime.combine(start + timedelta(days=7), datetime.min.time())
        case _:
            next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
            end = datetime.combine(next_month, datetime.min.time())
    return max(1, int((end - now).total_seconds())), int(end.timestamp())


def counter_key(user_id: str, window: str, start: date) -> str:
    return f"fp:rl:{user_id}:{window}:{start.isoformat()}"


def _limit_for(policy: RateLimitPolicy, window: str) -> int | None:
    return {
        "DAY": policy.daily_limit,
        "WEEK": policy.weekly_limit,
        "MONTH": policy.monthly_limit,
    }[window]


class RateLimiter:
    def __init__(self, repo: Repository, cache: CacheAdapter) -> None:
        self._repo = repo
        self._cache = cache

    async def check_and_reserve(
        self, user_id: str, roles: list[str], estimated_cost: int = 1
    ) -> RateLimitDecision:
        policy = await self._repo.rate_limit_policy(user_id, roles)
        if policy is None:
            # No policy configured anywhere, not even DEFAULT: allow, but say so
            # in the audit trail rather than silently applying an invented cap.
            return RateLimitDecision(decision="ALLOWED", remaining={}, policy=None, reserved=0)

        cost = estimated_cost if policy.limit_type == "TOKEN_COUNT" else 1

        applied: list[str] = []
        totals: dict[str, int] = {}
        for window in WINDOWS:
            limit = _limit_for(policy, window)
            if limit is None:
                continue
            ttl, _ = window_expiry(window)
            key = counter_key(user_id, window, period_start(window))
            totals[window] = await self._cache.incr(key, cost, ttl)
            applied.append(window)

            if totals[window] > limit:
                await self._rollback(user_id, applied, cost)
                if policy.overage_policy == "WARN_AND_ALLOW":
                    return RateLimitDecision(
                        decision="ALLOWED",
                        exceeded_window=window,
                        remaining={},
                        policy=policy,
                        reserved=0,
                    )
                _, reset_epoch = window_expiry(window)
                return RateLimitDecision(
                    decision="DENIED",
                    exceeded_window=window,
                    retry_after_epoch=reset_epoch,
                    policy=policy,
                    reserved=0,
                )

        remaining = {
            window.lower(): max(0, (_limit_for(policy, window) or 0) - totals.get(window, 0))
            for window in applied
        }
        return RateLimitDecision(
            decision="ALLOWED", remaining=remaining, policy=policy, reserved=cost
        )

    async def _rollback(self, user_id: str, windows: list[str], cost: int) -> None:
        for window in windows:
            ttl, _ = window_expiry(window)
            await self._cache.incr(counter_key(user_id, window, period_start(window)), -cost, ttl)

    async def reconcile(
        self, user_id: str, decision: RateLimitDecision, actual_tokens: int
    ) -> None:
        """Settle the estimate against what the LLM actually charged, then
        persist durable consumption for the dashboard."""
        policy = decision.policy
        if policy is None:
            return

        if policy.limit_type == "TOKEN_COUNT":
            delta = actual_tokens - decision.reserved
            settled = actual_tokens
        else:
            delta = 0
            settled = decision.reserved

        for window in WINDOWS:
            if _limit_for(policy, window) is None:
                continue
            start = period_start(window)
            if delta:
                ttl, _ = window_expiry(window)
                await self._cache.incr(counter_key(user_id, window, start), delta, ttl)
            if settled:
                await self._repo.upsert_consumption(user_id, window, start, settled)
