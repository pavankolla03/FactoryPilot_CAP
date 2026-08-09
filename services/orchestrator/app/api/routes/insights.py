"""Insights API — response shapes frozen in Component_Contracts.md section 2."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.auth.context import Identity, current_identity, require_scope
from app.graph.pipeline import run_query
from app.services.rate_limit import WINDOWS, counter_key, period_start

router = APIRouter(prefix="/insights", tags=["insights"])


class QueryRequest(BaseModel):
    questionText: str = Field(min_length=1, max_length=1000)
    businessObjectId: str | None = None
    filters: dict[str, Any] = Field(default_factory=dict)
    channel: str = "Web"


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/query")
async def query(
    body: QueryRequest,
    request: Request,
    identity: Identity = Depends(current_identity),
) -> JSONResponse:
    require_scope(identity, "InsightsQuery")

    filters = dict(body.filters)
    # A warehouse claim on the identity is the user's own default; an explicit
    # filter in the request still wins.
    if "warehouse" not in filters and identity.attributes.get("warehouse"):
        filters["warehouse"] = identity.attributes["warehouse"]

    state = await run_query(
        request.app.state.pipeline,
        question=body.questionText,
        user_id=identity.user_id,
        roles=identity.roles,
        channel=body.channel,
        user_filters=filters,
        requested_object_code=body.businessObjectId,
        correlation_id=request.headers.get("X-Correlation-ID"),
    )

    metadata = {
        "objectCode": state.get("object_code"),
        "cacheResult": state.get("cache_result", "NOT_APPLICABLE"),
        "rateLimitResult": state.get("rate_limit_result", "ALLOWED"),
        "tokensUsed": state.get("tokens_used", 0),
        "totalResponseTimeMs": state.get("total_ms", 0),
        "logId": state.get("log_id"),
        "correlationId": state.get("correlation_id"),
        "intentMethod": state.get("intent_method"),
        "rowCount": len(state.get("rows") or []),
    }
    status_value = state.get("status", "SUCCESS")

    if status_value == "RATE_LIMITED":
        decision = state.get("rate_limit_decision")
        return JSONResponse(
            status_code=429,
            content={
                "status": "RATE_LIMITED",
                "message": state.get("error_message", "Rate limit exceeded."),
                "exceededWindow": decision.exceeded_window if decision else "DAY",
                "retryAfterEpoch": decision.retry_after_epoch if decision else None,
                "metadata": metadata,
            },
        )

    if status_value == "ERROR":
        code = state.get("error_code", "UNEXPECTED")
        http_status = 400 if code in ("INTENT_UNRESOLVED", "CONFIG_OR_INTENT") else 502
        return JSONResponse(
            status_code=http_status,
            content={
                "status": "ERROR",
                "message": state.get("error_message", "Unexpected error."),
                "errorCode": code,
                "metadata": metadata,
            },
        )

    answer = state.get("answer") or {}
    return JSONResponse(
        status_code=200,
        content={
            "summaryText": answer.get("summaryText", ""),
            "metrics": answer.get("metrics", {}),
            "breakdowns": answer.get("breakdowns", []),
            "metadata": metadata,
        },
    )


@router.get("/usage/me")
async def usage_me(
    request: Request,
    identity: Identity = Depends(current_identity),
) -> dict[str, Any]:
    require_scope(identity, "InsightsReadOwnUsage")
    deps = request.app.state.deps

    policy = await deps.repo.rate_limit_policy(identity.user_id, identity.roles)
    limits = {
        "day": policy.daily_limit if policy else None,
        "week": policy.weekly_limit if policy else None,
        "month": policy.monthly_limit if policy else None,
    }
    used = {}
    for window in WINDOWS:
        key = counter_key(identity.user_id, window, period_start(window))
        used[window.lower()] = await deps.cache.get_int(key)

    return {
        "userId": identity.user_id,
        "limitType": policy.limit_type if policy else None,
        "limits": limits,
        "used": used,
        "durable": await deps.repo.consumption(identity.user_id),
    }
