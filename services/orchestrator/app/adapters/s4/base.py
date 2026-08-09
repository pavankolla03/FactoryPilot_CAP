"""S/4HANA OData access contract.

Three interchangeable modes behind one interface (`S4_ACCESS_MODE`):
  fake       — replay a synthetic fixture, no SAP account needed
  hub_direct — call the Business Accelerator Hub sandbox with an API key
  cpi        — go through the thin generic iFlow

The query is fully resolved by the caller before it gets here. The transport
never owns the OData catalog — that lives in CAP (ADR-016).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(slots=True)
class S4Query:
    destination_name: str
    service_path: str
    entity_set: str
    api_version: str = "v2"
    filter_expression: str = ""
    select_fields: str = ""
    top: int = 200
    base_url: str = ""
    correlation_id: str = ""


@dataclass(slots=True)
class S4Result:
    rows: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""
    status_code: int = 200
    elapsed_ms: int = 0


class S4Error(RuntimeError):
    """Upstream S/4 failure — mapped to errorCode S4_UPSTREAM."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class S4Client(Protocol):
    name: str

    async def query(self, request: S4Query) -> S4Result: ...


def build_query_string(request: S4Query) -> str:
    """OData v2 and v4 differ enough here to matter: v4 has no `$format=json`
    and expects unquoted `$top`."""
    params: list[str] = []
    if request.filter_expression:
        params.append(f"$filter={request.filter_expression}")
    if request.select_fields:
        params.append(f"$select={request.select_fields}")
    if request.top:
        params.append(f"$top={request.top}")
    if request.api_version == "v2":
        params.append("$format=json")
    return "&".join(params)


def extract_rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    """v2 nests under d.results; v4 uses a flat `value` array."""
    if not isinstance(body, dict):
        return []
    d = body.get("d")
    if isinstance(d, dict) and isinstance(d.get("results"), list):
        return [r for r in d["results"] if isinstance(r, dict)]
    if isinstance(d, list):
        return [r for r in d if isinstance(r, dict)]
    value = body.get("value")
    if isinstance(value, list):
        return [r for r in value if isinstance(r, dict)]
    return []
