"""In-process cache — local development and tests.

Single-process only: counters are correct under asyncio concurrency because of
the lock, but not across replicas. Anything with more than one instance needs
Redis (ADR-007).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any


class MemoryCacheAdapter:
    name = "memory"

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    def _live(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at and expires_at < time.time():
            self._store.pop(key, None)
            return None
        return value

    async def get(self, key: str) -> dict[str, Any] | None:
        async with self._lock:
            value = self._live(key)
        return value if isinstance(value, dict) else None

    async def set(self, key: str, payload: dict[str, Any], ttl_seconds: int) -> None:
        async with self._lock:
            self._store[key] = (time.time() + max(1, ttl_seconds), payload)

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._store.pop(key, None)

    async def incr(self, key: str, amount: int, ttl_seconds: int) -> int:
        async with self._lock:
            current = self._live(key)
            new_value = int(current or 0) + amount
            # Preserve the original window expiry — refreshing it on every
            # increment would let a steady stream of requests hold a day
            # counter open indefinitely.
            existing_expiry = self._store.get(key, (0.0, None))[0] if current is not None else 0.0
            expiry = existing_expiry or (time.time() + max(1, ttl_seconds))
            self._store[key] = (expiry, new_value)
            return new_value

    async def get_int(self, key: str) -> int:
        async with self._lock:
            return int(self._live(key) or 0)

    async def close(self) -> None:
        async with self._lock:
            self._store.clear()
