from __future__ import annotations

from app.config import Settings

from .aicore import AICoreLLMProvider
from .base import LLMProvider
from .fake import FakeLLMProvider
from .openrouter import OpenRouterLLMProvider


def get_llm_provider(settings: Settings) -> LLMProvider:
    """Resolve the configured provider. Business logic never calls a vendor
    class directly — only this factory (ADR-019)."""
    match settings.llm_provider:
        case "openrouter":
            return OpenRouterLLMProvider(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                default_model=settings.openrouter_model,
                timeout=settings.llm_timeout_seconds,
            )
        case "aicore":
            return AICoreLLMProvider(
                base_url=settings.aicore_base_url,
                deployment_id=settings.aicore_deployment_id,
                client_id=settings.aicore_client_id,
                client_secret=settings.aicore_client_secret,
                token_url=settings.aicore_token_url,
                timeout=settings.llm_timeout_seconds,
            )
        case "fake":
            return FakeLLMProvider()
        case other:  # pragma: no cover - pydantic validates the literal
            raise ValueError(f"Unknown llm_provider: {other}")
