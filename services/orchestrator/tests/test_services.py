"""Unit tests for intent, filters, cache keys and rate limiting."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.adapters.cache.memory import MemoryCacheAdapter
from app.adapters.db.base import BusinessObject, CachePolicy, RateLimitPolicy
from app.services.cache_key import build_cache_key, cache_subject, effective_ttl
from app.services.filters import (
    build_filter,
    detect_query_pattern,
    normalise_filter,
    odata_date_literal,
    seconds_until_midnight,
)
from app.services.intent import match_keywords, resolve_intent
from app.services.rate_limit import RateLimiter, period_start

# --- intent ----------------------------------------------------------------

OBJECTS = [
    BusinessObject(
        object_code="DELIVERY",
        keywords=["delivery", "deliveries", "outbound delivery", "warehouse"],
        is_active=True,
    ),
    BusinessObject(
        object_code="SALES",
        keywords=["order", "orders", "sales order"],
        is_active=True,
    ),
]


def test_longest_keyword_wins():
    # "sales order" (11 chars) must beat the bare "order" that DELIVERY-style
    # generic keywords would otherwise win on.
    assert match_keywords("how many sales order lines today", OBJECTS).object_code == "SALES"


def test_keyword_respects_word_boundaries():
    # "reorder" contains "order" but is not an order question.
    assert match_keywords("reorder point analysis", OBJECTS).object_code is None


def test_unmatched_question_returns_none():
    assert match_keywords("what is the weather", OBJECTS).object_code is None


async def test_explicit_object_code_skips_matching():
    result = await resolve_intent("anything at all", OBJECTS, explicit_code="delivery")
    assert result.object_code == "DELIVERY"
    assert result.method == "explicit"


async def test_explicit_unknown_code_is_rejected():
    result = await resolve_intent("anything", OBJECTS, explicit_code="NOPE")
    assert result.object_code is None


# --- filters ---------------------------------------------------------------

def test_build_filter_substitutes_placeholders():
    out = build_filter(
        "ActualGoodsMovementDate eq {today} and ShippingPoint eq '{warehouse}'",
        {"datePreset": "today", "warehouse": "1010"},
        api_version="v2",
        today=date(2026, 8, 9),
    )
    assert out == "ActualGoodsMovementDate eq datetime'2026-08-09T00:00:00' and ShippingPoint eq '1010'"


def test_unresolvable_clause_is_dropped_not_blanked():
    # Emitting `ShippingPoint eq ''` would return zero rows and read as a real
    # empty result. Dropping the clause is the honest behaviour.
    out = build_filter(
        "ActualGoodsMovementDate eq {today} and ShippingPoint eq '{warehouse}'",
        {"datePreset": "today"},
        api_version="v2",
        default_warehouse="",
        today=date(2026, 8, 9),
    )
    assert out == "ActualGoodsMovementDate eq datetime'2026-08-09T00:00:00'"
    assert "''" not in out


def test_v4_uses_bare_iso_date():
    assert odata_date_literal(date(2026, 8, 9), "v4") == "2026-08-09"


def test_normalise_filter_is_stable():
    a = normalise_filter("A eq 1   AND   B eq 2")
    b = normalise_filter("A eq 1 and B eq 2")
    assert a == b


def test_query_pattern_detection():
    assert detect_query_pattern("how many deliveries today", {"datePreset": "today"}) == "today-count"
    assert detect_query_pattern("show me the deliveries", {"datePreset": "today"}) == ""


# --- cache keys ------------------------------------------------------------

def test_cache_subject_strategies():
    assert cache_subject("PER_USER", "bob", ["BusinessUser"]) == "bob"
    assert cache_subject("GLOBAL", "bob", ["BusinessUser"]) == "GLOBAL"
    # Role order must not fragment the cache.
    assert cache_subject("PER_ROLE", "bob", ["B", "A"]) == cache_subject("PER_ROLE", "sue", ["A", "B"])


def test_cache_key_is_deterministic_and_scoped():
    a = build_cache_key("DELIVERY", "x eq 1", "bob", "")
    b = build_cache_key("DELIVERY", "x eq 1", "bob", "")
    c = build_cache_key("DELIVERY", "x eq 1", "sue", "")
    assert a == b and a != c
    assert a.startswith("fp:answer:delivery:")


def test_today_ttl_is_clamped_to_midnight():
    # 23:50 with a 15-minute policy must expire in 10 minutes, not 15 — or the
    # answer outlives the day it describes (ADR-010).
    policy = CachePolicy(object_code="DELIVERY", ttl_value=15, ttl_unit="MINUTES")
    late = datetime(2026, 8, 9, 23, 50, 0)
    assert effective_ttl(policy, "today", 900, now=late) == 600


def test_non_today_ttl_is_not_clamped():
    policy = CachePolicy(object_code="DELIVERY", ttl_value=15, ttl_unit="MINUTES")
    late = datetime(2026, 8, 9, 23, 50, 0)
    assert effective_ttl(policy, "yesterday", 900, now=late) == 900


def test_seconds_until_midnight_is_positive():
    assert 0 < seconds_until_midnight(datetime(2026, 8, 9, 12, 0, 0)) <= 86400


# --- rate limiting ---------------------------------------------------------

class StubRepo:
    def __init__(self, policy: RateLimitPolicy | None):
        self.policy = policy
        self.consumption_calls: list[tuple] = []

    async def rate_limit_policy(self, user_id, roles):
        return self.policy

    async def upsert_consumption(self, user_id, period_type, period_start, delta):
        self.consumption_calls.append((user_id, period_type, period_start, delta))


async def test_request_count_denies_at_limit():
    repo = StubRepo(RateLimitPolicy(user_id="bob", daily_limit=2, limit_type="REQUEST_COUNT"))
    limiter = RateLimiter(repo, MemoryCacheAdapter())

    assert (await limiter.check_and_reserve("bob", [])).decision == "ALLOWED"
    assert (await limiter.check_and_reserve("bob", [])).decision == "ALLOWED"
    third = await limiter.check_and_reserve("bob", [])
    assert third.decision == "DENIED"
    assert third.exceeded_window == "DAY"
    assert third.retry_after_epoch is not None


async def test_denied_reservation_is_rolled_back():
    """A denial must not consume quota, or one rejected request permanently
    burns a slot the user never got to use."""
    repo = StubRepo(
        RateLimitPolicy(user_id="bob", daily_limit=1, weekly_limit=10, limit_type="REQUEST_COUNT")
    )
    cache = MemoryCacheAdapter()
    limiter = RateLimiter(repo, cache)

    await limiter.check_and_reserve("bob", [])
    denied = await limiter.check_and_reserve("bob", [])
    assert denied.decision == "DENIED"

    from app.services.rate_limit import counter_key

    week = await cache.get_int(counter_key("bob", "WEEK", period_start("WEEK")))
    day = await cache.get_int(counter_key("bob", "DAY", period_start("DAY")))
    assert day == 1, "denied request must not leave a day increment behind"
    assert week == 1, "the week counter incremented before the day check must roll back too"


async def test_warn_and_allow_lets_the_request_through():
    repo = StubRepo(
        RateLimitPolicy(user_id="bob", daily_limit=1, overage_policy="WARN_AND_ALLOW")
    )
    limiter = RateLimiter(repo, MemoryCacheAdapter())
    await limiter.check_and_reserve("bob", [])
    second = await limiter.check_and_reserve("bob", [])
    assert second.decision == "ALLOWED"
    assert second.exceeded_window == "DAY"


async def test_missing_policy_allows_without_inventing_a_cap():
    limiter = RateLimiter(StubRepo(None), MemoryCacheAdapter())
    decision = await limiter.check_and_reserve("bob", [])
    assert decision.decision == "ALLOWED"
    assert decision.policy is None


async def test_token_count_reconciles_to_actual_usage():
    repo = StubRepo(RateLimitPolicy(user_id="bob", daily_limit=10_000, limit_type="TOKEN_COUNT"))
    cache = MemoryCacheAdapter()
    limiter = RateLimiter(repo, cache)

    decision = await limiter.check_and_reserve("bob", [], estimated_cost=800)
    assert decision.reserved == 800

    await limiter.reconcile("bob", decision, actual_tokens=120)

    from app.services.rate_limit import counter_key

    used = await cache.get_int(counter_key("bob", "DAY", period_start("DAY")))
    assert used == 120, "over-reservation must be refunded once real usage is known"
    assert ("bob", "DAY", period_start("DAY"), 120) in repo.consumption_calls


async def test_concurrent_reservations_cannot_both_win():
    import asyncio

    repo = StubRepo(RateLimitPolicy(user_id="bob", daily_limit=1))
    limiter = RateLimiter(repo, MemoryCacheAdapter())
    results = await asyncio.gather(
        limiter.check_and_reserve("bob", []),
        limiter.check_and_reserve("bob", []),
    )
    decisions = sorted(r.decision for r in results)
    assert decisions == ["ALLOWED", "DENIED"]


@pytest.mark.parametrize(
    "window,expected",
    [("DAY", date(2026, 8, 12)), ("WEEK", date(2026, 8, 10)), ("MONTH", date(2026, 8, 1))],
)
def test_period_starts(window, expected):
    # 2026-08-12 is a Wednesday; the week starts Monday the 10th.
    assert period_start(window, date(2026, 8, 12)) == expected
