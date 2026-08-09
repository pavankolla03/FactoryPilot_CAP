from __future__ import annotations

from app.config import Settings

from .base import S4Client


def get_s4_client(settings: Settings) -> S4Client:
    match settings.s4_access_mode:
        case "fake":
            from .fake import FakeS4Client

            return FakeS4Client()
        case "hub_direct":
            from .hub_client import HubODataClient

            return HubODataClient(
                api_key=settings.sap_hub_api_key, timeout=settings.s4_timeout_seconds
            )
        case "cpi":
            from .cpi_client import CpiODataClient

            return CpiODataClient(
                url=settings.cpi_url,
                token=settings.cpi_token,
                timeout=settings.s4_timeout_seconds,
            )
        case other:  # pragma: no cover - pydantic validates the literal
            raise ValueError(f"Unknown s4_access_mode: {other}")
