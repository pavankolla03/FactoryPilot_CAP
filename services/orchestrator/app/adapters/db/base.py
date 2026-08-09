"""Repository contract over the CAP-owned schema.

CAP owns the CDS model and its migrations; the orchestrator reads the same
tables directly so every query does not pay an extra OData hop (ADR-002).
Swapping SQLite for Postgres (or HANA later) is a factory choice — no caller
changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol


@dataclass(slots=True)
class BusinessObject:
    object_code: str
    object_name: str = ""
    module_domain: str = "SCM"
    keywords: list[str] = field(default_factory=list)
    destination_name: str = ""
    odata_service_path: str = ""
    entity_set: str = ""
    api_version: str = "v2"
    default_filters: str = ""
    select_fields: str = ""
    prompt_hints: str = ""
    hub_api_url: str = ""
    is_active: bool = False


@dataclass(slots=True)
class RateLimitPolicy:
    user_id: str
    daily_limit: int | None = None
    weekly_limit: int | None = None
    monthly_limit: int | None = None
    limit_type: str = "REQUEST_COUNT"
    overage_policy: str = "BLOCK"
    is_active: bool = True


@dataclass(slots=True)
class CachePolicy:
    object_code: str
    query_pattern: str = ""
    cache_enabled: bool = True
    ttl_value: int = 15
    ttl_unit: str = "MINUTES"
    cache_key_strategy: str = "PER_USER"
    is_active: bool = True

    @property
    def ttl_seconds(self) -> int:
        multiplier = {"MINUTES": 60, "HOURS": 3600, "DAYS": 86400}.get(self.ttl_unit, 60)
        return max(1, self.ttl_value) * multiplier


@dataclass(slots=True)
class LogRecord:
    log_id: str
    timestamp: datetime
    user_id: str
    channel: str
    object_code: str
    user_query: str
    odata_url_called: str = ""
    odata_response_time_ms: int = 0
    cache_result: str = "NOT_APPLICABLE"
    rate_limit_result: str = "ALLOWED"
    llm_provider: str = ""
    llm_model: str = ""
    tokens_used: int = 0
    total_response_time_ms: int = 0
    status: str = "SUCCESS"
    response_summary: str = ""
    error_detail: str = ""
    correlation_id: str = ""


class Repository(Protocol):
    async def active_business_objects(self) -> list[BusinessObject]: ...

    async def business_object(self, object_code: str) -> BusinessObject | None: ...

    async def rate_limit_policy(self, user_id: str, roles: list[str]) -> RateLimitPolicy | None: ...

    async def cache_policy(self, object_code: str, query_pattern: str = "") -> CachePolicy | None: ...

    async def write_log(self, record: LogRecord) -> None: ...

    async def upsert_consumption(
        self, user_id: str, period_type: str, period_start: date, delta: int
    ) -> None: ...

    async def consumption(self, user_id: str) -> dict[str, int]: ...

    async def close(self) -> None: ...
