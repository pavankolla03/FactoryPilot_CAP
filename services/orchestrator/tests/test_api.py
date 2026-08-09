"""HTTP contract tests — the shapes frozen in Component_Contracts.md section 2."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import httpx
import pytest

from app.auth.context import Identity, current_identity
from app.graph.pipeline import build_pipeline
from app.graph.state import Deps


@pytest.fixture
def client(deps: Deps):
    from app.main import app

    app.state.deps = deps
    app.state.pipeline = build_pipeline(deps)
    app.dependency_overrides[current_identity] = lambda: Identity(
        user_id="bob",
        roles=["BusinessUser", "InsightsQuery", "InsightsReadOwnUsage"],
        scopes=["InsightsQuery", "InsightsReadOwnUsage"],
    )
    transport = httpx.ASGITransport(app=app)
    yield httpx.AsyncClient(transport=transport, base_url="http://test")
    app.dependency_overrides.clear()


async def test_health(client):
    async with client as c:
        res = await c.get("/insights/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_query_returns_contract_shape(client):
    async with client as c:
        res = await c.post(
            "/insights/query",
            json={
                "questionText": "How many deliveries today in my warehouse?",
                "filters": {"datePreset": "today", "warehouse": "1000"},
                "channel": "Web",
            },
        )
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"summaryText", "metrics", "breakdowns", "metadata"}
    assert body["metadata"]["objectCode"] == "DELIVERY"
    assert body["metadata"]["cacheResult"] == "MISS"
    assert body["metadata"]["rateLimitResult"] == "ALLOWED"
    assert body["metadata"]["logId"]
    assert body["metrics"]["total"] == 4


async def test_unresolved_question_is_a_400(client):
    async with client as c:
        res = await c.post("/insights/query", json={"questionText": "what is the weather"})
    assert res.status_code == 400
    assert res.json()["errorCode"] == "INTENT_UNRESOLVED"


async def test_rate_limited_question_is_a_429(client, db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE factorypilot_UserRateLimitConfig SET dailyLimit = 1 WHERE userID = 'DEFAULT'")
    conn.commit()
    conn.close()

    payload = {"questionText": "deliveries today", "filters": {"warehouse": "1000"}}
    async with client as c:
        first = await c.post("/insights/query", json=payload)
        second = await c.post("/insights/query", json=payload)

    assert first.status_code == 200
    assert second.status_code == 429
    body = second.json()
    assert body["status"] == "RATE_LIMITED"
    assert body["exceededWindow"] == "DAY"
    assert body["retryAfterEpoch"]


async def test_empty_question_is_rejected_by_validation(client):
    async with client as c:
        res = await c.post("/insights/query", json={"questionText": ""})
    assert res.status_code == 422


async def test_usage_me_reports_limits_and_consumption(client):
    async with client as c:
        await c.post(
            "/insights/query",
            json={"questionText": "deliveries today", "filters": {"warehouse": "1000"}},
        )
        res = await c.get("/insights/usage/me")

    assert res.status_code == 200
    body = res.json()
    assert body["userId"] == "bob"
    assert body["limits"]["day"] == 50
    assert body["used"]["day"] == 1


async def test_missing_scope_is_a_403(deps: Deps):
    from app.main import app

    app.state.deps = deps
    app.state.pipeline = build_pipeline(deps)
    app.dependency_overrides[current_identity] = lambda: Identity(
        user_id="nobody", roles=[], scopes=[]
    )
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            res = await c.post("/insights/query", json={"questionText": "deliveries today"})
        assert res.status_code == 403
        assert "InsightsQuery" in res.json()["detail"]
    finally:
        app.dependency_overrides.clear()
