"""Cache key construction and TTL policy (Component_Contracts.md section 6)."""

from __future__ import annotations

import hashlib
from datetime import datetime

from app.adapters.db.base import CachePolicy

from .filters import seconds_until_midnight


def cache_subject(strategy: str, user_id: str, roles: list[str]) -> str:
    match strategy:
        case "PER_USER":
            return user_id
        case "PER_ROLE":
            # Sorted so two users with the same roles in a different order
            # share one cache entry rather than each warming their own.
            return "role:" + ",".join(sorted(roles)) if roles else "role:none"
        case _:
            return "GLOBAL"


def build_cache_key(
    object_code: str,
    normalised_filter: str,
    subject: str,
    query_pattern: str = "",
) -> str:
    material = f"{object_code}|{normalised_filter}|{subject}|{query_pattern}"
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    # Prefix keeps Redis browsable during incident triage.
    return f"fp:answer:{object_code.lower()}:{digest[:32]}"


def effective_ttl(
    policy: CachePolicy | None,
    date_preset: str,
    default_ttl_seconds: int,
    now: datetime | None = None,
) -> int:
    """A "today" answer must not outlive today.

    Plain TTL is not enough: a 15-minute entry written at 23:58 would still be
    served at 00:05 tomorrow, reporting yesterday's deliveries as today's
    (ADR-010).
    """
    ttl = policy.ttl_seconds if policy else default_ttl_seconds
    if (date_preset or "today").lower() == "today":
        ttl = min(ttl, seconds_until_midnight(now))
    return max(1, ttl)
