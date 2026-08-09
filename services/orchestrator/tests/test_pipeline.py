"""End-to-end pipeline tests.

The invariant these exist to protect: every request produces exactly one
CommunicationLog row, whatever path it took.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters.s4.base import S4Error, S4Query, S4Result
from app.graph.pipeline import build_pipeline, run_query
from app.graph.state import Deps
from conftest import log_rows

BUSINESS_USER = ["BusinessUser", "InsightsQuery"]


class CountingS4:
    """Wraps the fixture client so tests can prove a cache hit skipped S/4."""

    name = "counting"

    def __init__(self, inner):
        self.inner = inner
        self.calls = 0

    async def query(self, request: S4Query) -> S4Result:
        self.calls += 1
        return await self.inner.query(request)


class FailingS4:
    name = "failing"

    async def query(self, request: S4Query) -> S4Result:
        raise S4Error("Hub returned 503 for A_OutbDeliveryHeader", status_code=503)


class FailingLLM:
    name = "failing"

    async def complete(self, request):
        from app.adapters.llm.base import LLMError

        raise LLMError("OpenRouter timed out")


async def test_happy_path_returns_summary_and_writes_one_log(deps: Deps, pipeline, db_path: Path):
    state = await run_query(
        pipeline,
        question="How many deliveries today in my warehouse?",
        user_id="bob",
        roles=BUSINESS_USER,
        user_filters={"datePreset": "today", "warehouse": "1000"},
    )

    assert state["status"] == "SUCCESS"
    assert state["object_code"] == "DELIVERY"
    assert state["intent_method"] == "keyword"
    assert state["cache_result"] == "MISS"
    assert state["rate_limit_result"] == "ALLOWED"
    # 4 rows in the fixture are shipping point 1000 and dated today.
    assert len(state["rows"]) == 4
    assert state["answer"]["metrics"]["total"] == 4
    assert state["tokens_used"] > 0

    rows = log_rows(db_path)
    assert len(rows) == 1
    assert rows[0]["status"] == "SUCCESS"
    assert rows[0]["cacheResult"] == "MISS"
    assert rows[0]["objectCode"] == "DELIVERY"
    assert rows[0]["tokensUsed"] > 0
    assert rows[0]["correlationId"]


async def test_second_identical_question_hits_cache_and_skips_s4(deps: Deps, db_path: Path):
    counting = CountingS4(deps.s4)
    deps.s4 = counting
    pipeline = build_pipeline(deps)
    args = dict(
        question="How many deliveries today in my warehouse?",
        user_id="bob",
        roles=BUSINESS_USER,
        user_filters={"datePreset": "today", "warehouse": "1000"},
    )

    first = await run_query(pipeline, **args)
    second = await run_query(pipeline, **args)

    assert first["cache_result"] == "MISS"
    assert second["cache_result"] == "HIT"
    assert counting.calls == 1, "a cache hit must not reach S/4"
    assert second["answer"] == first["answer"]

    rows = log_rows(db_path)
    assert len(rows) == 2, "a cache hit still gets its own audit row"
    assert [r["cacheResult"] for r in rows] == ["MISS", "HIT"]


async def test_different_warehouse_is_a_different_cache_entry(deps: Deps):
    counting = CountingS4(deps.s4)
    deps.s4 = counting
    pipeline = build_pipeline(deps)

    await run_query(
        pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1000"},
    )
    await run_query(
        pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1010"},
    )
    assert counting.calls == 2


async def test_cache_is_scoped_per_user(deps: Deps):
    counting = CountingS4(deps.s4)
    deps.s4 = counting
    pipeline = build_pipeline(deps)
    args = dict(question="deliveries today", roles=BUSINESS_USER, user_filters={"warehouse": "1000"})

    await run_query(pipeline, user_id="bob", **args)
    await run_query(pipeline, user_id="sue", **args)
    assert counting.calls == 2, "PER_USER strategy must not leak one user's answer to another"


async def test_rate_limit_denies_and_never_calls_s4_or_llm(deps: Deps, db_path: Path):
    import sqlite3

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE factorypilot_UserRateLimitConfig SET dailyLimit = 1 WHERE userID = 'DEFAULT'")
    conn.commit()
    conn.close()

    counting = CountingS4(deps.s4)
    deps.s4 = counting
    pipeline = build_pipeline(deps)
    args = dict(
        question="How many deliveries today?", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1000"},
    )

    first = await run_query(pipeline, **args)
    second = await run_query(pipeline, **args)

    assert first["status"] == "SUCCESS"
    assert second["status"] == "RATE_LIMITED"
    assert second["rate_limit_result"] == "DENIED"
    assert counting.calls == 1, "a denied request must not reach S/4"
    assert second.get("tokens_used", 0) == 0

    rows = log_rows(db_path)
    assert len(rows) == 2
    assert rows[1]["status"] == "RATE_LIMITED"
    assert rows[1]["rateLimitResult"] == "DENIED"


async def test_rate_limit_applies_even_when_the_answer_is_cached(deps: Deps, db_path: Path):
    """The reason the limit cannot live on CPI: this request never touches it."""
    import sqlite3

    args = dict(
        question="How many deliveries today?", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1000"},
    )
    pipeline = build_pipeline(deps)
    await run_query(pipeline, **args)  # warms the cache

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE factorypilot_UserRateLimitConfig SET dailyLimit = 1 WHERE userID = 'DEFAULT'")
    conn.commit()
    conn.close()

    denied = await run_query(pipeline, **args)
    assert denied["status"] == "RATE_LIMITED"
    assert denied.get("answer") is None, "quota must be enforced before the cache is read"


async def test_unresolved_intent_is_an_error_with_a_log_row(deps: Deps, pipeline, db_path: Path):
    state = await run_query(
        pipeline, question="what is the weather in Berlin", user_id="bob", roles=BUSINESS_USER
    )
    assert state["status"] == "ERROR"
    assert state["error_code"] == "INTENT_UNRESOLVED"

    rows = log_rows(db_path)
    assert len(rows) == 1
    assert rows[0]["status"] == "ERROR"
    assert rows[0]["objectCode"] == ""


async def test_inactive_business_object_is_rejected(deps: Deps, pipeline, db_path: Path):
    import sqlite3

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE factorypilot_BusinessObjectConfig SET isActive = 0 WHERE objectCode = 'DELIVERY'")
    conn.commit()
    conn.close()

    state = await run_query(
        pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
        requested_object_code="DELIVERY",
    )
    assert state["status"] == "ERROR"
    assert len(log_rows(db_path)) == 1


async def test_s4_failure_is_graceful_and_audited(deps: Deps, db_path: Path):
    deps.s4 = FailingS4()
    pipeline = build_pipeline(deps)

    state = await run_query(
        pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1000"},
    )
    assert state["status"] == "ERROR"
    assert state["error_code"] == "S4_UPSTREAM"

    rows = log_rows(db_path)
    assert len(rows) == 1
    assert rows[0]["status"] == "ERROR"
    assert "503" in rows[0]["errorDetail"]


async def test_llm_failure_refunds_reserved_tokens(deps: Deps, db_path: Path):
    """A failed LLM call must not permanently consume the tokens it reserved."""
    import sqlite3

    conn = sqlite3.connect(db_path)
    # All three windows have to move to token scale together — leaving the
    # weekly cap at its request-count value (200) would deny an 800-token
    # reservation before the LLM is ever reached.
    conn.execute(
        "UPDATE factorypilot_UserRateLimitConfig SET limitType = 'TOKEN_COUNT', "
        "dailyLimit = 5000, weeklyLimit = 20000, monthlyLimit = 50000 "
        "WHERE userID = 'DEFAULT'"
    )
    conn.commit()
    conn.close()

    deps.llm = FailingLLM()
    pipeline = build_pipeline(deps)

    state = await run_query(
        pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
        user_filters={"warehouse": "1000"},
    )
    assert state["status"] == "ERROR"
    assert state["error_code"] == "LLM_UPSTREAM"

    from app.services.rate_limit import counter_key, period_start

    used = await deps.cache.get_int(counter_key("bob", "DAY", period_start("DAY")))
    assert used == 0, "the 800-token reservation must be refunded when the call fails"


async def test_explicit_object_code_bypasses_keyword_matching(deps: Deps, pipeline):
    state = await run_query(
        pipeline,
        question="give me the numbers",  # matches no keyword
        user_id="bob",
        roles=BUSINESS_USER,
        requested_object_code="DELIVERY",
        user_filters={"warehouse": "1000"},
    )
    assert state["status"] == "SUCCESS"
    assert state["intent_method"] == "explicit"


async def test_every_path_writes_exactly_one_log_row(deps: Deps, pipeline, db_path: Path):
    await run_query(pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
                    user_filters={"warehouse": "1000"})
    await run_query(pipeline, question="deliveries today", user_id="bob", roles=BUSINESS_USER,
                    user_filters={"warehouse": "1000"})  # cache hit
    await run_query(pipeline, question="unmatchable gibberish", user_id="bob", roles=BUSINESS_USER)

    rows = log_rows(db_path)
    assert len(rows) == 3
    assert [r["status"] for r in rows] == ["SUCCESS", "SUCCESS", "ERROR"]


@pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "apps/admin-cap/db/factorypilot.db").exists(),
    reason="CAP database not deployed — run `npm run deploy` in apps/admin-cap",
)
async def test_schema_parity_with_deployed_cap_database():
    """The hermetic test DDL above is a copy. If CAP's model changes and this
    fails, the copy is stale — not the CAP model."""
    import sqlite3

    from conftest import CAP_DB, DDL

    real = sqlite3.connect(CAP_DB)
    mirror = sqlite3.connect(":memory:")
    mirror.executescript(DDL)
    try:
        for table in (
            "factorypilot_BusinessObjectConfig",
            "factorypilot_UserRateLimitConfig",
            "factorypilot_CacheConfig",
            "factorypilot_CommunicationLog",
            "factorypilot_UserConsumption",
        ):
            real_cols = {r[1] for r in real.execute(f"PRAGMA table_info({table})")}
            mirror_cols = {r[1] for r in mirror.execute(f"PRAGMA table_info({table})")}
            assert real_cols == mirror_cols, f"{table} drifted: {real_cols ^ mirror_cols}"
    finally:
        real.close()
        mirror.close()
