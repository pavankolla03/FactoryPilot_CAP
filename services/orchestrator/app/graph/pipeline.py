"""LangGraph wiring.

    IntentResolve -> LoadConfig -> RateLimitGate -> CacheLookup
                                        |               |
                                    (denied)         (hit) -> AuditLog
                                        |               |
                                        v            (miss) -> CallS4
                                    AuditLog                     |
                                                        LlmContextualize
                                                                 |
                                                            CacheWrite -> AuditLog

Every branch converges on AuditLog, including failures — that is what
guarantees one log row per request.
"""

from __future__ import annotations

import time
import uuid
from functools import partial
from typing import Any

from langgraph.graph import END, StateGraph

from . import nodes
from .state import Deps, GraphState

_TERMINAL = ("ERROR", "RATE_LIMITED")


def _halted(state: GraphState) -> bool:
    return state.get("status") in _TERMINAL


def _after(next_node: str):
    """Continue unless a node has already decided the request is over."""

    def route(state: GraphState) -> str:
        return "audit_log" if _halted(state) else next_node

    return route


def _after_cache_lookup(state: GraphState) -> str:
    if _halted(state):
        return "audit_log"
    return "audit_log" if state.get("cache_result") == "HIT" else "call_s4"


def build_pipeline(deps: Deps):
    graph = StateGraph(GraphState)

    graph.add_node("intent_resolve", partial(nodes.intent_resolve, deps=deps))
    graph.add_node("load_config", partial(nodes.load_config, deps=deps))
    graph.add_node("rate_limit_gate", partial(nodes.rate_limit_gate, deps=deps))
    graph.add_node("cache_lookup", partial(nodes.cache_lookup, deps=deps))
    graph.add_node("call_s4", partial(nodes.call_s4, deps=deps))
    graph.add_node("llm_contextualize", partial(nodes.llm_contextualize, deps=deps))
    graph.add_node("cache_write", partial(nodes.cache_write, deps=deps))
    graph.add_node("audit_log", partial(nodes.audit_log, deps=deps))

    graph.set_entry_point("intent_resolve")
    graph.add_conditional_edges("intent_resolve", _after("load_config"))
    graph.add_conditional_edges("load_config", _after("rate_limit_gate"))
    graph.add_conditional_edges("rate_limit_gate", _after("cache_lookup"))
    graph.add_conditional_edges("cache_lookup", _after_cache_lookup)
    graph.add_conditional_edges("call_s4", _after("llm_contextualize"))
    graph.add_conditional_edges("llm_contextualize", _after("cache_write"))
    graph.add_edge("cache_write", "audit_log")
    graph.add_edge("audit_log", END)

    return graph.compile()


async def run_query(
    pipeline: Any,
    *,
    question: str,
    user_id: str,
    roles: list[str],
    channel: str = "Web",
    user_filters: dict[str, Any] | None = None,
    requested_object_code: str | None = None,
    correlation_id: str | None = None,
) -> GraphState:
    initial: GraphState = {
        "correlation_id": correlation_id or str(uuid.uuid4()),
        "user_id": user_id,
        "roles": roles,
        "channel": channel,
        "question": question,
        "requested_object_code": requested_object_code,
        "user_filters": user_filters or {},
        "started_at": time.perf_counter(),
        "status": "SUCCESS",
        "cache_result": "NOT_APPLICABLE",
        "rate_limit_result": "ALLOWED",
        "rows": [],
        "tokens_used": 0,
    }
    return await pipeline.ainvoke(initial)
