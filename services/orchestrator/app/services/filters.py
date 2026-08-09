"""Turn a business object's filter template plus user hints into OData.

The template lives in CAP (`defaultFilters`) so a functional consultant can
change what "today in my warehouse" means without a deploy.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def resolve_date_preset(preset: str, today: date | None = None) -> date:
    today = today or date.today()
    match (preset or "today").lower():
        case "today":
            return today
        case "yesterday":
            return today - timedelta(days=1)
        case "tomorrow":
            return today + timedelta(days=1)
        case _:
            return today


def odata_date_literal(value: date, api_version: str) -> str:
    """v2 wants `datetime'...'`; v4 takes a bare ISO date."""
    if api_version == "v2":
        return f"datetime'{value.isoformat()}T00:00:00'"
    return value.isoformat()


def build_filter(
    template: str,
    user_filters: dict[str, Any],
    api_version: str = "v2",
    default_warehouse: str = "",
    today: date | None = None,
) -> str:
    """Substitute {placeholders} in the template.

    A placeholder with no value drops its whole `and` clause rather than
    emitting `eq ''`, which would silently return zero rows and look like a
    legitimately empty result.
    """
    if not template:
        return ""

    resolved_date = resolve_date_preset(str(user_filters.get("datePreset", "today")), today)
    values: dict[str, str] = {
        "today": odata_date_literal(resolved_date, api_version),
        "date": odata_date_literal(resolved_date, api_version),
        "warehouse": str(user_filters.get("warehouse") or default_warehouse or ""),
        "plant": str(user_filters.get("plant") or default_warehouse or ""),
    }
    for key, value in user_filters.items():
        if isinstance(value, (str, int, float)) and key not in values:
            values[key] = str(value)

    clauses = _split_on_and(template)
    kept: list[str] = []
    for clause in clauses:
        names = _PLACEHOLDER.findall(clause)
        if names and any(not values.get(n) for n in names):
            continue  # unresolvable — drop the clause instead of guessing
        kept.append(_PLACEHOLDER.sub(lambda m: values.get(m.group(1), ""), clause))

    return " and ".join(c.strip() for c in kept if c.strip())


def _split_on_and(expression: str) -> list[str]:
    return re.split(r"\s+and\s+", expression, flags=re.IGNORECASE)


def normalise_filter(filter_expression: str) -> str:
    """Stable form for cache keys: collapse whitespace, lowercase keywords.

    Two questions that resolve to the same filter must hash identically, or the
    cache never hits.
    """
    collapsed = re.sub(r"\s+", " ", filter_expression or "").strip()
    return re.sub(r"\s+(and|or)\s+", lambda m: f" {m.group(1).lower()} ", collapsed, flags=re.IGNORECASE)


def detect_query_pattern(question: str, user_filters: dict[str, Any]) -> str:
    """Coarse pattern so admins can set a shorter TTL for volatile questions
    (CacheConfig.queryPattern)."""
    text = (question or "").lower()
    is_today = str(user_filters.get("datePreset", "today")).lower() == "today"
    counting = any(w in text for w in ("how many", "count", "number of", "total"))
    if is_today and counting:
        return "today-count"
    return ""


def seconds_until_midnight(now: datetime | None = None) -> int:
    now = now or datetime.now()
    tomorrow = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    return max(1, int((tomorrow - now).total_seconds()))
