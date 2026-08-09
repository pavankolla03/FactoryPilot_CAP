"""Redis cache and rate-limit counters — the BTP path (ADR-007)."""

from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis


class RedisCacheAdapter:
    name = "redis"

    def __init__(self, url: str, client: Any | None = None) -> None:
        self._client = client or aioredis.from_url(url, decode_responses=True)

    async def get(self, key: str) -> dict[str, Any] | None:
        raw = await self._client.get(key)
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return value if isinstance(value, dict) else None

    async def set(self, key: str, payload: dict[str, Any], ttl_seconds: int) -> None:
        await self._client.set(key, json.dumps(payload), ex=max(1, ttl_seconds))

    async def delete(self, key: str) -> None:
        await self._client.delete(key)

    async def incr(self, key: str, amount: int, ttl_seconds: int) -> int:
        # INCRBY is atomic; the EXPIRE is applied only when the key is new (NX)
        # so a busy user cannot keep pushing the window's end further out.
        pipe = self._client.pipeline()
        pipe.incrby(key, amount)
        pipe.expire(key, max(1, ttl_seconds), nx=True)
        result = await pipe.execute()
        return int(result[0])

    async def get_int(self, key: str) -> int:
        raw = await self._client.get(key)
        try:
            return int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            return 0

    async def close(self) -> None:
        await self._client.aclose()
