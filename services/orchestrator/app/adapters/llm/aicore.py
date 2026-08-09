"""SAP AI Core / GenAI Hub adapter.

Same `complete()` contract as OpenRouter, so flipping `llm_provider` is the only
change a client landscape needs (ADR-005).

Auth is OAuth2 client credentials against the AI Core token URL; the token is
cached until shortly before expiry.
"""

from __future__ import annotations

import time

import httpx

from .base import LLMError, LLMRequest, LLMResponse
from .openrouter import _try_json


class AICoreLLMProvider:
    name = "aicore"

    def __init__(
        self,
        base_url: str,
        deployment_id: str,
        client_id: str,
        client_secret: str,
        token_url: str,
        default_model: str = "",
        timeout: float = 30.0,
        resource_group: str = "default",
    ) -> None:
        missing = [
            n
            for n, v in (
                ("AICORE_BASE_URL", base_url),
                ("AICORE_DEPLOYMENT_ID", deployment_id),
                ("AICORE_CLIENT_ID", client_id),
                ("AICORE_CLIENT_SECRET", client_secret),
                ("AICORE_TOKEN_URL", token_url),
            )
            if not v
        ]
        if missing:
            raise LLMError(f"AI Core is not configured — missing {', '.join(missing)}")
        self._base_url = base_url.rstrip("/")
        self._deployment_id = deployment_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._token_url = token_url
        self._default_model = default_model
        self._timeout = timeout
        self._resource_group = resource_group
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    async def _access_token(self, client: httpx.AsyncClient) -> str:
        if self._token and time.time() < self._token_expires_at:
            return self._token
        try:
            res = await client.post(
                self._token_url,
                data={"grant_type": "client_credentials"},
                auth=(self._client_id, self._client_secret),
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"AI Core token request failed: {exc}") from exc
        if res.status_code >= 400:
            raise LLMError(f"AI Core token endpoint returned {res.status_code}")
        body = res.json()
        self._token = body["access_token"]
        # Refresh a minute early rather than racing the expiry.
        self._token_expires_at = time.time() + max(60, int(body.get("expires_in", 3600))) - 60
        return self._token

    async def complete(self, request: LLMRequest) -> LLMResponse:
        url = (
            f"{self._base_url}/v2/inference/deployments/"
            f"{self._deployment_id}/chat/completions"
        )
        payload = {
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }
        model = request.model or self._default_model
        if model:
            payload["model"] = model

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                token = await self._access_token(client)
                res = await client.post(
                    url,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "AI-Resource-Group": self._resource_group,
                        "Content-Type": "application/json",
                    },
                )
        except httpx.HTTPError as exc:
            raise LLMError(f"AI Core request failed: {exc}") from exc

        if res.status_code >= 400:
            raise LLMError(f"AI Core returned {res.status_code}: {res.text[:300]}")

        body = res.json()
        choices = body.get("choices") or []
        if not choices:
            raise LLMError("AI Core returned no choices")
        text = choices[0].get("message", {}).get("content", "") or ""
        usage = body.get("usage") or {}

        return LLMResponse(
            text=text,
            provider=self.name,
            model=body.get("model", model or self._deployment_id),
            tokens_used=usage.get("total_tokens", 0),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            structured=_try_json(text),
        )
