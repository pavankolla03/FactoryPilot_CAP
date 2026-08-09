"""OpenRouter chat-completions adapter."""

from __future__ import annotations

import json

import httpx

from .base import LLMError, LLMMessage, LLMRequest, LLMResponse


class OpenRouterLLMProvider:
    name = "openrouter"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://openrouter.ai/api/v1",
        default_model: str = "anthropic/claude-sonnet-4.5",
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise LLMError("OPENROUTER_API_KEY is not set")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._default_model = default_model
        self._timeout = timeout

    async def complete(self, request: LLMRequest) -> LLMResponse:
        model = request.model or self._default_model
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "X-Title": "FactoryPilot Insights",
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(
                    f"{self._base_url}/chat/completions", json=payload, headers=headers
                )
        except httpx.HTTPError as exc:  # network, DNS, timeout
            raise LLMError(f"OpenRouter request failed: {exc}") from exc

        if res.status_code >= 400:
            raise LLMError(f"OpenRouter returned {res.status_code}: {res.text[:300]}")

        body = res.json()
        choices = body.get("choices") or []
        if not choices:
            raise LLMError("OpenRouter returned no choices")
        text = choices[0].get("message", {}).get("content", "") or ""
        usage = body.get("usage") or {}

        return LLMResponse(
            text=text,
            provider=self.name,
            model=body.get("model", model),
            tokens_used=usage.get("total_tokens", 0),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            structured=_try_json(text),
        )


def _try_json(text: str) -> dict | None:
    """Models often wrap JSON in prose or a fenced block. Recover it if we can."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text.removeprefix("json").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = ["OpenRouterLLMProvider", "LLMMessage", "LLMRequest", "LLMResponse"]
