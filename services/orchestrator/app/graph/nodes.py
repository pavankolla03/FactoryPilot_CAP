"""Pipeline nodes.

Order is deliberate (Architecture_Concept.md section 7): the rate-limit gate
runs *before* the cache lookup and before S/4, so a user over quota is stopped
whether or not their answer happens to be cached — that is the whole reason the
limit cannot live on the CPI hop.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone

from app.adapters.db.base import LogRecord
from app.adapters.llm.base import LLMError, LLMMessage, LLMRequest
from app.adapters.s4.base import S4Error, S4Query
from app.services import intent as intent_service
from app.services.cache_key import build_cache_key, cache_subject, effective_ttl
from app.services.filters import build_filter, detect_query_pattern, normalise_filter

from .state import Deps, GraphState

log = logging.getLogger("factorypilot.graph")

# Trimmed before the prompt: a 200-row payload is both expensive and worse for
# summary quality than a representative slice.
MAX_ROWS_TO_LLM = 60


async def intent_resolve(state: GraphState, deps: Deps) -> GraphState:
    objects = await deps.repo.active_business_objects()
    if not objects:
        return {
            "status": "ERROR",
            "error_code": "NO_ACTIVE_BUSINESS_OBJECTS",
            "error_message": "No active business object is registered. Register one in the admin console.",
        }

    result = await intent_service.resolve_intent(
        question=state.get("question", ""),
        objects=objects,
        explicit_code=state.get("requested_object_code"),
        llm=deps.llm,
        enable_llm_fallback=deps.settings.enable_llm_intent_fallback,
    )
    if not result.object_code:
        # Worth logging: unresolved questions are the raw material for tuning
        # the keyword lists in the admin UI.
        log.info("intent unresolved: %s", state.get("question", "")[:200])
        return {
            "status": "ERROR",
            "error_code": "INTENT_UNRESOLVED",
            "error_message": "Could not match that question to a registered business object.",
            "intent_method": result.method,
        }
    return {"object_code": result.object_code, "intent_method": result.method}


async def load_config(state: GraphState, deps: Deps) -> GraphState:
    object_code = state["object_code"]
    business_object = await deps.repo.business_object(object_code)
    if business_object is None or not business_object.is_active:
        return {
            "status": "ERROR",
            "error_code": "CONFIG_OR_INTENT",
            "error_message": f"Business object {object_code} is not active.",
        }
    if not business_object.entity_set or not business_object.odata_service_path:
        return {
            "status": "ERROR",
            "error_code": "CONFIG_OR_INTENT",
            "error_message": (
                f"{object_code} is active but has no OData service path or entity set configured."
            ),
        }

    user_filters = state.get("user_filters") or {}
    filter_expression = build_filter(
        template=business_object.default_filters,
        user_filters=user_filters,
        api_version=business_object.api_version,
        default_warehouse=deps.settings.default_warehouse,
    )
    query_pattern = detect_query_pattern(state.get("question", ""), user_filters)
    cache_policy = await deps.repo.cache_policy(object_code, query_pattern)
    subject = cache_subject(
        cache_policy.cache_key_strategy if cache_policy else "PER_USER",
        state.get("user_id", ""),
        state.get("roles", []),
    )
    normalised = normalise_filter(filter_expression)

    return {
        "business_object": business_object,
        "cache_policy": cache_policy,
        "filter_expression": filter_expression,
        "normalised_filter": normalised,
        "query_pattern": query_pattern,
        "cache_key": build_cache_key(object_code, normalised, subject, query_pattern),
    }


async def rate_limit_gate(state: GraphState, deps: Deps) -> GraphState:
    decision = await deps.rate_limiter.check_and_reserve(
        user_id=state.get("user_id", ""),
        roles=state.get("roles", []),
        estimated_cost=deps.settings.llm_max_tokens,
    )
    if decision.decision == "DENIED":
        window = (decision.exceeded_window or "DAY").lower()
        return {
            "rate_limit_decision": decision,
            "rate_limit_result": "DENIED",
            "status": "RATE_LIMITED",
            "error_code": "RATE_LIMITED",
            "error_message": f"{window.capitalize()} limit exceeded. Try again after the next reset window.",
        }
    return {"rate_limit_decision": decision, "rate_limit_result": "ALLOWED"}


async def cache_lookup(state: GraphState, deps: Deps) -> GraphState:
    policy = state.get("cache_policy")
    if policy is not None and not policy.cache_enabled:
        return {"cache_result": "NOT_APPLICABLE"}

    cached = await deps.cache.get(state["cache_key"])
    if cached:
        return {"cache_result": "HIT", "answer": cached, "status": "SUCCESS"}
    return {"cache_result": "MISS"}


async def call_s4(state: GraphState, deps: Deps) -> GraphState:
    business_object = state["business_object"]
    query = S4Query(
        destination_name=business_object.destination_name,
        service_path=business_object.odata_service_path,
        entity_set=business_object.entity_set,
        api_version=business_object.api_version,
        filter_expression=state.get("filter_expression", ""),
        select_fields=business_object.select_fields,
        top=deps.settings.s4_top,
        base_url=business_object.hub_api_url,
        correlation_id=state.get("correlation_id", ""),
    )
    try:
        result = await deps.s4.query(query)
    except S4Error as exc:
        return {
            "status": "ERROR",
            "error_code": "S4_UPSTREAM",
            "error_message": str(exc),
            "odata_url": "",
        }
    return {"rows": result.rows, "odata_url": result.url, "odata_ms": result.elapsed_ms}


async def llm_contextualize(state: GraphState, deps: Deps) -> GraphState:
    business_object = state["business_object"]
    rows = state.get("rows", [])
    system = (
        business_object.prompt_hints
        or "You summarise SAP S/4HANA operational data for business users."
    ) + (
        "\nAnswer with a single JSON object: "
        '{"summaryText": str, "metrics": {..}, "breakdowns": [{"key": str, "items": [{"name": str, "count": int}]}]}. '
        "Base every number strictly on the rows provided. Do not invent records."
    )
    user = (
        f"Question: {state.get('question', '')}\n"
        f"Row count: {len(rows)}\n"
        f"Data (first {MAX_ROWS_TO_LLM} rows): {json.dumps(rows[:MAX_ROWS_TO_LLM], default=str)}"
    )

    try:
        response = await deps.llm.complete(
            LLMRequest(
                messages=[
                    LLMMessage(role="system", content=system),
                    LLMMessage(role="user", content=user),
                ],
                max_tokens=deps.settings.llm_max_tokens,
                temperature=deps.settings.llm_temperature,
                metadata={
                    "objectCode": state.get("object_code", ""),
                    "userId": state.get("user_id", ""),
                },
            )
        )
    except LLMError as exc:
        return {
            "status": "ERROR",
            "error_code": "LLM_UPSTREAM",
            "error_message": str(exc),
        }

    structured = response.structured or {}
    answer = {
        "summaryText": structured.get("summaryText") or response.text.strip(),
        "metrics": structured.get("metrics") or {"total": len(rows)},
        "breakdowns": structured.get("breakdowns") or [],
    }
    return {
        "answer": answer,
        "status": "SUCCESS",
        "tokens_used": response.tokens_used,
        "llm_provider": response.provider,
        "llm_model": response.model,
    }


async def cache_write(state: GraphState, deps: Deps) -> GraphState:
    policy = state.get("cache_policy")
    if policy is not None and not policy.cache_enabled:
        return {}
    answer = state.get("answer")
    if not answer:
        return {}

    ttl = effective_ttl(
        policy,
        str((state.get("user_filters") or {}).get("datePreset", "today")),
        deps.settings.default_cache_ttl_seconds,
    )
    await deps.cache.set(state["cache_key"], answer, ttl)
    return {}


async def audit_log(state: GraphState, deps: Deps) -> GraphState:
    """Terminal node. Every path reaches it, so every request produces exactly
    one CommunicationLog row — the auditability NFR."""
    decision = state.get("rate_limit_decision")
    if decision is not None:
        try:
            await deps.rate_limiter.reconcile(
                state.get("user_id", ""), decision, state.get("tokens_used", 0)
            )
        except Exception:  # never let bookkeeping sink the response
            log.exception("rate-limit reconciliation failed")

    started = state.get("started_at") or time.perf_counter()
    total_ms = int((time.perf_counter() - started) * 1000)
    log_id = state.get("log_id") or str(uuid.uuid4())
    answer = state.get("answer") or {}

    record = LogRecord(
        log_id=log_id,
        timestamp=datetime.now(timezone.utc),
        user_id=state.get("user_id", ""),
        channel=state.get("channel", "Web"),
        object_code=state.get("object_code") or "",
        user_query=state.get("question", ""),
        odata_url_called=state.get("odata_url", ""),
        odata_response_time_ms=state.get("odata_ms", 0),
        cache_result=state.get("cache_result", "NOT_APPLICABLE"),
        rate_limit_result=state.get("rate_limit_result", "ALLOWED"),
        llm_provider=state.get("llm_provider", ""),
        llm_model=state.get("llm_model", ""),
        tokens_used=state.get("tokens_used", 0),
        total_response_time_ms=total_ms,
        status=state.get("status", "SUCCESS"),
        response_summary=str(answer.get("summaryText", "")),
        error_detail=state.get("error_message", ""),
        correlation_id=state.get("correlation_id", ""),
    )
    try:
        await deps.repo.write_log(record)
    except Exception:
        # A failed audit write must be loud but must not turn a served answer
        # into a 500 for the user.
        log.exception("failed to write CommunicationLog row %s", log_id)

    return {"log_id": log_id, "total_ms": total_ms}
