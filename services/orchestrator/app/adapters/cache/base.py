"""Cache + counter contract (Component_Contracts.md section 6).

One adapter covers both jobs because they share a store: TTL'd contextualised
answers, and the atomic day/week/month counters the rate limiter reserves
against. `incr` must be atomic — two concurrent requests must never both see
room under the same limit.
"""

from __future__ import annotations

from typing import Any, Protocol


class CacheAdapter(Protocol):
    name: str

    async def get(self, key: str) -> dict[str, Any] | None: ...

    async def set(self, key: str, payload: dict[str, Any], ttl_seconds: int) -> None: ...

    async def delete(self, key: str) -> None: ...

    async def incr(self, key: str, amount: int, ttl_seconds: int) -> int: ...

    async def get_int(self, key: str) -> int: ...

    async def close(self) -> None: ...
