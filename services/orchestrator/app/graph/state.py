"""Shared state for the LangGraph pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict

from app.adapters.cache.base import CacheAdapter
from app.adapters.db.base import BusinessObject, CachePolicy, Repository
from app.adapters.llm.base import LLMProvider
from app.adapters.s4.base import S4Client
from app.config import Settings
from app.services.rate_limit import RateLimiter, RateLimitDecision


@dataclass(slots=True)
class Deps:
    """Everything the graph talks to. Nodes receive this, never a vendor SDK."""

    settings: Settings
    repo: Repository
    cache: CacheAdapter
    llm: LLMProvider
    s4: S4Client
    rate_limiter: RateLimiter


class GraphState(TypedDict, total=False):
    # request
    correlation_id: str
    user_id: str
    roles: list[str]
    channel: str
    question: str
    requested_object_code: str | None
    user_filters: dict[str, Any]
    started_at: float

    # resolution
    object_code: str | None
    intent_method: str
    business_object: BusinessObject | None
    cache_policy: CachePolicy | None
    filter_expression: str
    normalised_filter: str
    query_pattern: str
    cache_key: str

    # execution
    rate_limit_decision: RateLimitDecision | None
    rate_limit_result: str
    cache_result: str
    rows: list[dict[str, Any]]
    odata_url: str
    odata_ms: int
    llm_provider: str
    llm_model: str
    tokens_used: int

    # outcome
    answer: dict[str, Any] | None
    status: str          # SUCCESS | RATE_LIMITED | ERROR
    error_code: str
    error_message: str
    log_id: str
    total_ms: int
