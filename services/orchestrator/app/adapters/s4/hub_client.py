"""SAP Business Accelerator Hub sandbox client (`S4_ACCESS_MODE=hub_direct`).

Days 1–4 of the delivery plan call the Hub directly so the pipeline can be
proven before Integration Suite exists. The same class points at a customer S/4
later — only the base URL and auth on the Destination change.
"""

from __future__ import annotations

import time

import httpx

from .base import S4Error, S4Query, S4Result, build_query_string, extract_rows

DEFAULT_HUB_BASE = "https://sandbox.api.sap.com/s4hanacloud"


class HubODataClient:
    name = "hub_direct"

    def __init__(self, api_key: str, timeout: float = 15.0, base_url: str = DEFAULT_HUB_BASE) -> None:
        if not api_key:
            raise S4Error(
                "SAP_HUB_API_KEY is not set — create a Hub application at api.sap.com "
                "and put the key in .env (see docs/api/hub/DAY1_MANUAL_CHECKLIST.md)",
                status_code=503,
            )
        self._api_key = api_key
        self._timeout = timeout
        self._base_url = base_url.rstrip("/")

    def _url(self, request: S4Query) -> str:
        base = (request.base_url or f"{self._base_url}{request.service_path}").rstrip("/")
        query = build_query_string(request)
        return f"{base}/{request.entity_set}" + (f"?{query}" if query else "")

    async def query(self, request: S4Query) -> S4Result:
        url = self._url(request)
        started = time.perf_counter()
        headers = {"APIKey": self._api_key, "Accept": "application/json"}
        if request.correlation_id:
            headers["X-Correlation-ID"] = request.correlation_id

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise S4Error(f"Hub request failed: {exc}") from exc

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        if res.status_code >= 400:
            raise S4Error(
                f"Hub returned {res.status_code} for {request.entity_set}: {res.text[:200]}",
                status_code=res.status_code,
            )

        try:
            body = res.json()
        except ValueError as exc:
            raise S4Error("Hub returned a non-JSON body") from exc

        return S4Result(
            rows=extract_rows(body), url=url, status_code=res.status_code, elapsed_ms=elapsed_ms
        )
