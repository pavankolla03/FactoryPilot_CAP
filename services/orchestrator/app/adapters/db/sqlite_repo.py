"""SQLite repository — the local development path.

Reads the exact tables `cds deploy` creates, so the orchestrator and the CAP
admin UI are looking at one database with no sync step.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import date
from pathlib import Path

from .base import BusinessObject, CachePolicy, LogRecord, RateLimitPolicy

_BO_COLUMNS = """
    objectCode, objectName, moduleDomain, keywords, destinationName,
    odataServicePath, entitySet, apiVersion, defaultFilters, selectFields,
    promptHints, hubApiUrl, isActive
"""


def _to_business_object(row: sqlite3.Row) -> BusinessObject:
    return BusinessObject(
        object_code=row["objectCode"],
        object_name=row["objectName"] or "",
        module_domain=row["moduleDomain"] or "SCM",
        keywords=[k.strip().lower() for k in (row["keywords"] or "").split(",") if k.strip()],
        destination_name=row["destinationName"] or "",
        odata_service_path=row["odataServicePath"] or "",
        entity_set=row["entitySet"] or "",
        api_version=row["apiVersion"] or "v2",
        default_filters=row["defaultFilters"] or "",
        select_fields=row["selectFields"] or "",
        prompt_hints=row["promptHints"] or "",
        hub_api_url=row["hubApiUrl"] or "",
        is_active=bool(row["isActive"]),
    )


class SqliteRepository:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        if not self._path.exists():
            raise FileNotFoundError(
                f"CAP database not found at {self._path}. "
                "Run `npm run deploy` in apps/admin-cap first."
            )
        self._lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    async def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        def run() -> list[sqlite3.Row]:
            with self._connect() as conn:
                return conn.execute(sql, params).fetchall()

        return await asyncio.to_thread(run)

    async def _execute(self, sql: str, params: tuple = ()) -> None:
        def run() -> None:
            with self._connect() as conn:
                conn.execute(sql, params)
                conn.commit()

        async with self._lock:
            await asyncio.to_thread(run)

    # --- reads --------------------------------------------------------------

    async def active_business_objects(self) -> list[BusinessObject]:
        rows = await self._query(
            f"SELECT {_BO_COLUMNS} FROM factorypilot_BusinessObjectConfig "
            "WHERE isActive = 1 ORDER BY objectCode"
        )
        return [_to_business_object(r) for r in rows]

    async def business_object(self, object_code: str) -> BusinessObject | None:
        rows = await self._query(
            f"SELECT {_BO_COLUMNS} FROM factorypilot_BusinessObjectConfig "
            "WHERE objectCode = ?",
            (object_code,),
        )
        return _to_business_object(rows[0]) if rows else None

    async def rate_limit_policy(self, user_id: str, roles: list[str]) -> RateLimitPolicy | None:
        # Most specific wins: the user's own row, then any role row, then DEFAULT.
        candidates = [user_id, *roles, "DEFAULT"]
        placeholders = ",".join("?" for _ in candidates)
        rows = await self._query(
            "SELECT userID, dailyLimit, weeklyLimit, monthlyLimit, limitType, "
            "overagePolicy, isActive FROM factorypilot_UserRateLimitConfig "
            f"WHERE isActive = 1 AND userID IN ({placeholders})",
            tuple(candidates),
        )
        by_id = {r["userID"]: r for r in rows}
        for key in candidates:
            row = by_id.get(key)
            if row:
                return RateLimitPolicy(
                    user_id=row["userID"],
                    daily_limit=row["dailyLimit"],
                    weekly_limit=row["weeklyLimit"],
                    monthly_limit=row["monthlyLimit"],
                    limit_type=row["limitType"] or "REQUEST_COUNT",
                    overage_policy=row["overagePolicy"] or "BLOCK",
                    is_active=True,
                )
        return None

    async def cache_policy(self, object_code: str, query_pattern: str = "") -> CachePolicy | None:
        rows = await self._query(
            "SELECT objectCode, queryPattern, cacheEnabled, ttlValue, ttlUnit, "
            "cacheKeyStrategy, isActive FROM factorypilot_CacheConfig "
            "WHERE isActive = 1 AND objectCode = ?",
            (object_code,),
        )
        if not rows:
            return None
        exact = [r for r in rows if (r["queryPattern"] or "") == query_pattern]
        generic = [r for r in rows if not (r["queryPattern"] or "")]
        row = (exact or generic or rows)[0]
        return CachePolicy(
            object_code=row["objectCode"],
            query_pattern=row["queryPattern"] or "",
            cache_enabled=bool(row["cacheEnabled"]),
            ttl_value=row["ttlValue"] or 15,
            ttl_unit=row["ttlUnit"] or "MINUTES",
            cache_key_strategy=row["cacheKeyStrategy"] or "PER_USER",
            is_active=True,
        )

    async def consumption(self, user_id: str) -> dict[str, int]:
        rows = await self._query(
            "SELECT periodType, consumedCount FROM factorypilot_UserConsumption "
            "WHERE userID = ?",
            (user_id,),
        )
        return {r["periodType"]: r["consumedCount"] or 0 for r in rows}

    # --- writes -------------------------------------------------------------

    async def write_log(self, record: LogRecord) -> None:
        await self._execute(
            "INSERT INTO factorypilot_CommunicationLog ("
            "ID, timestamp, userID, channel, objectCode, userQuery, odataURLCalled, "
            "odataResponseTimeMs, cacheResult, rateLimitResult, llmProvider, llmModel, "
            "tokensUsed, totalResponseTimeMs, status, responseSummary, errorDetail, "
            "correlationId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                record.log_id,
                record.timestamp.isoformat(),
                record.user_id,
                record.channel,
                record.object_code,
                record.user_query[:1000],
                record.odata_url_called[:500],
                record.odata_response_time_ms,
                record.cache_result,
                record.rate_limit_result,
                record.llm_provider,
                record.llm_model,
                record.tokens_used,
                record.total_response_time_ms,
                record.status,
                record.response_summary[:2000],
                record.error_detail[:1000],
                record.correlation_id,
            ),
        )

    async def upsert_consumption(
        self, user_id: str, period_type: str, period_start: date, delta: int
    ) -> None:
        def run() -> None:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE factorypilot_UserConsumption "
                    "SET consumedCount = consumedCount + ?, lastUpdated = datetime('now') "
                    "WHERE userID = ? AND periodType = ? AND periodStart = ?",
                    (delta, user_id, period_type, period_start.isoformat()),
                )
                if cur.rowcount == 0:
                    conn.execute(
                        "INSERT INTO factorypilot_UserConsumption "
                        "(ID, userID, periodType, periodStart, consumedCount, lastUpdated) "
                        "VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))",
                        (user_id, period_type, period_start.isoformat(), delta),
                    )
                conn.commit()

        async with self._lock:
            await asyncio.to_thread(run)

    async def close(self) -> None:
        return None
