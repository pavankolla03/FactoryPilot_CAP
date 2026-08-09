"""PostgreSQL repository — the BTP deployment path.

Same tables, same semantics as SQLite; only placeholder style and the upsert
differ. The `psycopg` driver is imported lazily so a local SQLite run needs no
Postgres client installed.
"""

from __future__ import annotations

from datetime import date

from .base import BusinessObject, CachePolicy, LogRecord, RateLimitPolicy

_BO_COLUMNS = """
    "objectCode", "objectName", "moduleDomain", keywords, "destinationName",
    "odataServicePath", "entitySet", "apiVersion", "defaultFilters", "selectFields",
    "promptHints", "hubApiUrl", "isActive"
"""


def _to_business_object(row: dict) -> BusinessObject:
    return BusinessObject(
        object_code=row["objectCode"],
        object_name=row.get("objectName") or "",
        module_domain=row.get("moduleDomain") or "SCM",
        keywords=[k.strip().lower() for k in (row.get("keywords") or "").split(",") if k.strip()],
        destination_name=row.get("destinationName") or "",
        odata_service_path=row.get("odataServicePath") or "",
        entity_set=row.get("entitySet") or "",
        api_version=row.get("apiVersion") or "v2",
        default_filters=row.get("defaultFilters") or "",
        select_fields=row.get("selectFields") or "",
        prompt_hints=row.get("promptHints") or "",
        hub_api_url=row.get("hubApiUrl") or "",
        is_active=bool(row.get("isActive")),
    )


class PostgresRepository:
    def __init__(self, dsn: str) -> None:
        if not dsn:
            raise ValueError("POSTGRES_DSN is required when db_engine=postgres")
        try:
            from psycopg_pool import AsyncConnectionPool
        except ImportError as exc:  # pragma: no cover - driver is optional
            raise ImportError(
                "db_engine=postgres needs the Postgres driver: "
                "pip install 'psycopg[binary,pool]'"
            ) from exc
        self._pool = AsyncConnectionPool(dsn, open=False, min_size=1, max_size=8)
        self._opened = False

    async def _ensure_open(self) -> None:
        if not self._opened:
            await self._pool.open(wait=True)
            self._opened = True

    async def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        from psycopg.rows import dict_row

        await self._ensure_open()
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, params)
                return await cur.fetchall()

    async def _execute(self, sql: str, params: tuple = ()) -> None:
        await self._ensure_open()
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)

    # --- reads --------------------------------------------------------------

    async def active_business_objects(self) -> list[BusinessObject]:
        rows = await self._query(
            f'SELECT {_BO_COLUMNS} FROM factorypilot_BusinessObjectConfig '
            'WHERE "isActive" = true ORDER BY "objectCode"'
        )
        return [_to_business_object(r) for r in rows]

    async def business_object(self, object_code: str) -> BusinessObject | None:
        rows = await self._query(
            f'SELECT {_BO_COLUMNS} FROM factorypilot_BusinessObjectConfig '
            'WHERE "objectCode" = %s',
            (object_code,),
        )
        return _to_business_object(rows[0]) if rows else None

    async def rate_limit_policy(self, user_id: str, roles: list[str]) -> RateLimitPolicy | None:
        candidates = [user_id, *roles, "DEFAULT"]
        rows = await self._query(
            'SELECT "userID", "dailyLimit", "weeklyLimit", "monthlyLimit", "limitType", '
            '"overagePolicy" FROM factorypilot_UserRateLimitConfig '
            'WHERE "isActive" = true AND "userID" = ANY(%s)',
            (candidates,),
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
                )
        return None

    async def cache_policy(self, object_code: str, query_pattern: str = "") -> CachePolicy | None:
        rows = await self._query(
            'SELECT "objectCode", "queryPattern", "cacheEnabled", "ttlValue", "ttlUnit", '
            '"cacheKeyStrategy" FROM factorypilot_CacheConfig '
            'WHERE "isActive" = true AND "objectCode" = %s',
            (object_code,),
        )
        if not rows:
            return None
        exact = [r for r in rows if (r.get("queryPattern") or "") == query_pattern]
        generic = [r for r in rows if not (r.get("queryPattern") or "")]
        row = (exact or generic or rows)[0]
        return CachePolicy(
            object_code=row["objectCode"],
            query_pattern=row.get("queryPattern") or "",
            cache_enabled=bool(row.get("cacheEnabled")),
            ttl_value=row.get("ttlValue") or 15,
            ttl_unit=row.get("ttlUnit") or "MINUTES",
            cache_key_strategy=row.get("cacheKeyStrategy") or "PER_USER",
        )

    async def consumption(self, user_id: str) -> dict[str, int]:
        rows = await self._query(
            'SELECT "periodType", "consumedCount" FROM factorypilot_UserConsumption '
            'WHERE "userID" = %s',
            (user_id,),
        )
        return {r["periodType"]: r["consumedCount"] or 0 for r in rows}

    # --- writes -------------------------------------------------------------

    async def write_log(self, record: LogRecord) -> None:
        await self._execute(
            'INSERT INTO factorypilot_CommunicationLog ('
            '"ID", "timestamp", "userID", channel, "objectCode", "userQuery", '
            '"odataURLCalled", "odataResponseTimeMs", "cacheResult", "rateLimitResult", '
            '"llmProvider", "llmModel", "tokensUsed", "totalResponseTimeMs", status, '
            '"responseSummary", "errorDetail", "correlationId") '
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                record.log_id,
                record.timestamp,
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
        # Needs a unique index on (userID, periodType, periodStart); the CAP
        # deploy creates the table, so the index ships in infra/sql/.
        await self._execute(
            'INSERT INTO factorypilot_UserConsumption '
            '("ID", "userID", "periodType", "periodStart", "consumedCount", "lastUpdated") '
            "VALUES (gen_random_uuid(), %s, %s, %s, %s, now()) "
            'ON CONFLICT ("userID", "periodType", "periodStart") DO UPDATE '
            'SET "consumedCount" = factorypilot_UserConsumption."consumedCount" + EXCLUDED."consumedCount", '
            '"lastUpdated" = now()',
            (user_id, period_type, period_start, delta),
        )

    async def close(self) -> None:
        if self._opened:
            await self._pool.close()
            self._opened = False
