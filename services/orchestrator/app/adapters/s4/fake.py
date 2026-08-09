"""Fixture-backed S/4 client (`S4_ACCESS_MODE=fake`).

Lets the whole pipeline run with no SAP account. The fixture is clearly marked
synthetic — it is NOT a capture from a real Hub Try Out, and must not be
presented as one.

It does real work: filters on shipping point and goods-movement date so cache
keys, row counts and the LLM summary differ per question the way they would
against a live service.
"""

from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .base import S4Error, S4Query, S4Result, build_query_string, extract_rows

DEFAULT_FIXTURE = Path("docs/api/hub/delivery/sample_response.synthetic.json")


class FakeS4Client:
    name = "fake"

    def __init__(self, fixture_path: str | Path = DEFAULT_FIXTURE) -> None:
        self._fixture_path = Path(fixture_path)

    def _load(self) -> list[dict[str, Any]]:
        if not self._fixture_path.exists():
            raise S4Error(f"Fixture not found: {self._fixture_path}", status_code=503)
        try:
            body = json.loads(self._fixture_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise S4Error(f"Fixture is not valid JSON: {exc}") from exc

        rows = extract_rows(body)
        # The fixture was generated on a fixed day. Shift its dates so "today"
        # still returns rows whenever the demo is run, instead of quietly
        # answering zero a day after the file was written.
        base = (body.get("_synthetic") or {}).get("baseDate") if isinstance(body, dict) else None
        if base:
            try:
                shift = date.today() - date.fromisoformat(base)
            except ValueError:
                shift = timedelta(0)
            if shift:
                rows = [_shift_dates(r, shift) for r in rows]
        return rows

    async def query(self, request: S4Query) -> S4Result:
        started = time.perf_counter()
        rows = self._load()

        for field, value in _parse_equalities(request.filter_expression):
            if field.endswith("Date"):
                rows = [r for r in rows if _as_date(r.get(field)) == value]
            else:
                rows = [r for r in rows if str(r.get(field, "")) == value]

        if request.select_fields:
            wanted = [f.strip() for f in request.select_fields.split(",") if f.strip()]
            rows = [{k: r.get(k) for k in wanted} for r in rows]

        if request.top:
            rows = rows[: request.top]

        query = build_query_string(request)
        url = f"fake://{request.entity_set}" + (f"?{query}" if query else "")
        return S4Result(
            rows=rows,
            url=url,
            status_code=200,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )


def _shift_dates(row: dict[str, Any], shift: timedelta) -> dict[str, Any]:
    out = dict(row)
    for key, value in row.items():
        if not key.endswith("Date"):
            continue
        parsed = _as_date(value)
        if not parsed:
            continue
        moved = date.fromisoformat(parsed) + shift
        # Keep whichever wire format the fixture used.
        if str(value).startswith("/Date("):
            ms = int(datetime(moved.year, moved.month, moved.day, tzinfo=timezone.utc).timestamp() * 1000)
            out[key] = f"/Date({ms})/"
        else:
            out[key] = moved.isoformat()
    return out


_EQ = re.compile(r"(\w+)\s+eq\s+(?:'([^']*)'|datetime'([^']*)'|([\w\-.:]+))", re.IGNORECASE)


def _parse_equalities(filter_expression: str) -> list[tuple[str, str]]:
    """Only `field eq value` clauses joined by `and` — enough for the MVP's
    filter templates. Anything richer belongs against a real service."""
    if not filter_expression:
        return []
    out: list[tuple[str, str]] = []
    for match in _EQ.finditer(filter_expression):
        field = match.group(1)
        raw = match.group(2) or match.group(3) or match.group(4) or ""
        if field.endswith("Date"):
            parsed = _as_date(raw)
            if parsed:
                out.append((field, parsed))
        else:
            out.append((field, raw))
    return out


def _as_date(value: Any) -> str:
    """Normalise the several shapes a date arrives in — OData v2 ticks
    (/Date(1712016000000)/), ISO datetimes, and plain dates — to YYYY-MM-DD."""
    if value is None:
        return ""
    text = str(value)
    ticks = re.match(r"/Date\((\d+)", text)
    if ticks:
        return date.fromtimestamp(int(ticks.group(1)) / 1000).isoformat()
    return text[:10]
