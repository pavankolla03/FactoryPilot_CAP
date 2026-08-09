"""Thin CPI iFlow client (`S4_ACCESS_MODE=cpi`).

Posts the fully-resolved query to the generic iFlow, exactly the payload in
Component_Contracts.md section 4. The iFlow does destination lookup, the OData
GET, retry and error mapping — no LLM, no cache, no rate limit, no catalog.
"""

from __future__ import annotations

import time

import httpx

from .base import S4Error, S4Query, S4Result, extract_rows


class CpiODataClient:
    name = "cpi"

    def __init__(self, url: str, token: str = "", timeout: float = 15.0) -> None:
        if not url:
            raise S4Error("CPI_URL is required when s4_access_mode=cpi", status_code=503)
        self._url = url
        self._token = token
        self._timeout = timeout

    async def query(self, request: S4Query) -> S4Result:
        payload = {
            "destinationName": request.destination_name,
            "servicePath": request.service_path,
            "entitySet": request.entity_set,
            "apiVersion": request.api_version,
            "queryOptions": {
                "filter": request.filter_expression,
                "select": request.select_fields,
                "top": request.top,
            },
            "correlationId": request.correlation_id,
        }
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.post(self._url, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise S4Error(f"CPI request failed: {exc}") from exc

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        if res.status_code >= 400:
            raise S4Error(f"CPI returned {res.status_code}: {res.text[:200]}", res.status_code)

        body = res.json()
        # The iFlow wraps the S/4 payload: {statusCode, body, elapsedMs}.
        inner = body.get("body", body) if isinstance(body, dict) else {}
        if isinstance(body, dict) and body.get("errorCode"):
            raise S4Error(f"{body['errorCode']}: {body.get('message', '')}")

        return S4Result(
            rows=extract_rows(inner),
            url=f"{self._url}#{request.entity_set}",
            status_code=int(body.get("statusCode", res.status_code)) if isinstance(body, dict) else res.status_code,
            elapsed_ms=int(body.get("elapsedMs", elapsed_ms)) if isinstance(body, dict) else elapsed_ms,
        )
