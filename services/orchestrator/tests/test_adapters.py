"""Adapter-level tests: S/4 fixture client, caches, LLM providers, factories."""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.adapters.cache.memory import MemoryCacheAdapter
from app.adapters.cache.redis_cache import RedisCacheAdapter
from app.adapters.llm.base import LLMError, LLMMessage, LLMRequest
from app.adapters.llm.factory import get_llm_provider
from app.adapters.llm.fake import FakeLLMProvider
from app.adapters.llm.openrouter import _try_json
from app.adapters.s4.base import S4Query, build_query_string, extract_rows
from app.adapters.s4.factory import get_s4_client
from app.adapters.s4.fake import FakeS4Client
from app.config import Settings

# --- S/4 fixture client ----------------------------------------------------

def _query(**kwargs) -> S4Query:
    defaults = dict(
        destination_name="D",
        service_path="/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV",
        entity_set="A_OutbDeliveryHeader",
        api_version="v2",
        top=200,
    )
    return S4Query(**{**defaults, **kwargs})


async def test_fake_client_filters_by_shipping_point(fixture_path: Path):
    client = FakeS4Client(fixture_path)
    result = await client.query(_query(filter_expression="ShippingPoint eq '1010'"))
    assert result.rows
    assert {r["ShippingPoint"] for r in result.rows} == {"1010"}


async def test_fake_client_filters_by_date(fixture_path: Path):
    client = FakeS4Client(fixture_path)
    today = date.today()
    literal = f"datetime'{today.isoformat()}T00:00:00'"
    result = await client.query(_query(filter_expression=f"ActualGoodsMovementDate eq {literal}"))
    # The fixture has 6 rows today, one yesterday, one tomorrow.
    assert len(result.rows) == 6


async def test_fake_client_combines_filters(fixture_path: Path):
    client = FakeS4Client(fixture_path)
    literal = f"datetime'{date.today().isoformat()}T00:00:00'"
    result = await client.query(
        _query(filter_expression=f"ActualGoodsMovementDate eq {literal} and ShippingPoint eq '1000'")
    )
    assert len(result.rows) == 4


async def test_fake_client_applies_select_and_top(fixture_path: Path):
    client = FakeS4Client(fixture_path)
    result = await client.query(_query(select_fields="DeliveryDocument,ShippingPoint", top=2))
    assert len(result.rows) == 2
    assert set(result.rows[0].keys()) == {"DeliveryDocument", "ShippingPoint"}


async def test_fake_client_rebases_stale_fixture_dates(tmp_path: Path):
    """A fixture written a week ago must still answer "today" questions, or the
    offline demo silently reports zero the day after it was generated."""
    stale = date.today() - timedelta(days=7)
    ms = int(datetime(stale.year, stale.month, stale.day, tzinfo=timezone.utc).timestamp() * 1000)
    path = tmp_path / "stale.json"
    path.write_text(
        json.dumps({
            "_synthetic": {"baseDate": stale.isoformat()},
            "d": {"results": [{"DeliveryDocument": "1", "ActualGoodsMovementDate": f"/Date({ms})/"}]},
        }),
        encoding="utf-8",
    )
    client = FakeS4Client(path)
    literal = f"datetime'{date.today().isoformat()}T00:00:00'"
    result = await client.query(_query(filter_expression=f"ActualGoodsMovementDate eq {literal}"))
    assert len(result.rows) == 1


def test_build_query_string_v2_adds_format_json():
    assert "$format=json" in build_query_string(_query(filter_expression="A eq 1"))


def test_build_query_string_v4_omits_format():
    assert "$format=json" not in build_query_string(_query(api_version="v4"))


def test_extract_rows_handles_v2_and_v4():
    assert extract_rows({"d": {"results": [{"a": 1}]}}) == [{"a": 1}]
    assert extract_rows({"value": [{"a": 1}]}) == [{"a": 1}]
    assert extract_rows({"nothing": True}) == []


# --- caches ----------------------------------------------------------------

async def test_memory_cache_roundtrip_and_expiry():
    cache = MemoryCacheAdapter()
    await cache.set("k", {"v": 1}, ttl_seconds=60)
    assert await cache.get("k") == {"v": 1}
    await cache.delete("k")
    assert await cache.get("k") is None


async def test_memory_counter_expiry_is_not_extended_by_traffic():
    """A steady stream of requests must not push the day window's end further
    out — that would make the daily limit unenforceable."""
    cache = MemoryCacheAdapter()
    await cache.incr("c", 1, ttl_seconds=100)
    first_expiry = cache._store["c"][0]
    await cache.incr("c", 1, ttl_seconds=100)
    assert cache._store["c"][0] == first_expiry
    assert await cache.get_int("c") == 2


async def test_memory_incr_is_atomic_under_concurrency():
    cache = MemoryCacheAdapter()
    await asyncio.gather(*(cache.incr("c", 1, 60) for _ in range(50)))
    assert await cache.get_int("c") == 50


async def test_redis_adapter_against_fakeredis():
    fakeredis = pytest.importorskip("fakeredis")
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    cache = RedisCacheAdapter(url="", client=client)

    await cache.set("k", {"v": 2}, ttl_seconds=60)
    assert await cache.get("k") == {"v": 2}
    assert await cache.incr("c", 3, 60) == 3
    assert await cache.incr("c", 2, 60) == 5
    assert await cache.get_int("c") == 5
    await cache.delete("k")
    assert await cache.get("k") is None
    await cache.close()


async def test_redis_get_returns_none_for_non_json():
    fakeredis = pytest.importorskip("fakeredis")
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await client.set("k", "not json")
    cache = RedisCacheAdapter(url="", client=client)
    assert await cache.get("k") is None


# --- LLM -------------------------------------------------------------------

async def test_fake_llm_counts_rows_from_the_prompt():
    rows = [
        {"OverallGoodsMovementStatus": "A"},
        {"OverallGoodsMovementStatus": "A"},
        {"OverallGoodsMovementStatus": "C"},
    ]
    request = LLMRequest(
        messages=[
            LLMMessage(role="system", content="summarise"),
            LLMMessage(role="user", content=f"Question: how many?\nData: {json.dumps(rows)}"),
        ]
    )
    response = await FakeLLMProvider().complete(request)
    assert response.structured["metrics"]["total"] == 3
    assert response.structured["metrics"]["completed"] == 1
    assert response.structured["metrics"]["pending"] == 2
    assert response.tokens_used > 0


async def test_fake_llm_handles_no_rows():
    request = LLMRequest(messages=[LLMMessage(role="user", content="Question: x\nData: []")])
    response = await FakeLLMProvider().complete(request)
    assert response.structured["metrics"]["total"] == 0
    assert "No records" in response.structured["summaryText"]


def test_try_json_recovers_fenced_output():
    assert _try_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _try_json('Sure! {"a": 2} hope that helps') == {"a": 2}
    assert _try_json("no json here") is None


def test_llm_factory_refuses_openrouter_without_a_key():
    with pytest.raises(LLMError, match="OPENROUTER_API_KEY"):
        get_llm_provider(Settings(llm_provider="openrouter", openrouter_api_key=""))


def test_llm_factory_refuses_aicore_without_config():
    with pytest.raises(LLMError, match="AICORE_"):
        get_llm_provider(Settings(llm_provider="aicore"))


def test_llm_factory_returns_fake_by_default():
    assert get_llm_provider(Settings(llm_provider="fake")).name == "fake"


def test_s4_factory_selects_mode():
    assert get_s4_client(Settings(s4_access_mode="fake")).name == "fake"
    assert (
        get_s4_client(Settings(s4_access_mode="hub_direct", sap_hub_api_key="k")).name
        == "hub_direct"
    )
