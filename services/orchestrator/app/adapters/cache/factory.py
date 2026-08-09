from __future__ import annotations

from app.config import Settings

from .base import CacheAdapter


def get_cache_adapter(settings: Settings) -> CacheAdapter:
    match settings.cache_engine:
        case "memory":
            from .memory import MemoryCacheAdapter

            return MemoryCacheAdapter()
        case "redis":
            from .redis_cache import RedisCacheAdapter

            return RedisCacheAdapter(settings.redis_url)
        case other:  # pragma: no cover - pydantic validates the literal
            raise ValueError(f"Unknown cache_engine: {other}")
