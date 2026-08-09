"""LLM provider contract (Component_Contracts.md section 5, ADR-019).

Graph nodes call `complete()` and nothing else. No vendor SDK is imported
anywhere but the concrete adapters in this package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(slots=True)
class LLMMessage:
    role: str
    content: str


@dataclass(slots=True)
class LLMRequest:
    messages: list[LLMMessage]
    model: str | None = None
    max_tokens: int = 800
    temperature: float = 0.2
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LLMResponse:
    text: str
    provider: str
    model: str
    tokens_used: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    structured: dict[str, Any] | None = None


class LLMError(RuntimeError):
    """Upstream LLM failure — mapped to errorCode LLM_UPSTREAM."""


class LLMProvider(Protocol):
    name: str

    async def complete(self, request: LLMRequest) -> LLMResponse: ...
