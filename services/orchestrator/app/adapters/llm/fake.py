"""Deterministic offline LLM.

Not a stub that returns a placeholder: it actually reads the OData rows handed
to it and produces the same shape a real model is prompted for, so the whole
pipeline — cache, token reconciliation, audit — exercises real values with no
API key. Tests assert against it; the demo runs on it.
"""

from __future__ import annotations

import json
import re

from .base import LLMRequest, LLMResponse

_STATUS_LABEL = {
    "A": "not started",
    "B": "partially processed",
    "C": "completed",
}


class FakeLLMProvider:
    name = "fake"

    def __init__(self, model: str = "fake/deterministic-v1") -> None:
        self._model = model

    async def complete(self, request: LLMRequest) -> LLMResponse:
        user_text = next(
            (m.content for m in reversed(request.messages) if m.role == "user"), ""
        )
        rows = _extract_rows(user_text)
        question = _extract_question(user_text)

        by_status: dict[str, int] = {}
        for row in rows:
            status = str(row.get("OverallGoodsMovementStatus") or "unknown")
            by_status[status] = by_status.get(status, 0) + 1

        total = len(rows)
        completed = by_status.get("C", 0)
        pending = total - completed

        if total:
            parts = ", ".join(
                f"{count} {_STATUS_LABEL.get(code, code)}"
                for code, count in sorted(by_status.items())
            )
            summary = (
                f"You have {total} record(s) matching that question. "
                f"Breakdown by goods-movement status: {parts}."
            )
        else:
            summary = "No records matched that question for the requested period and location."

        structured = {
            "summaryText": summary,
            "metrics": {"total": total, "completed": completed, "pending": pending},
            "breakdowns": [
                {
                    "key": "OverallGoodsMovementStatus",
                    "items": [
                        {"name": _STATUS_LABEL.get(code, code), "count": count}
                        for code, count in sorted(by_status.items())
                    ],
                }
            ],
        }

        # Rough but stable token accounting so rate-limit reconciliation has
        # something real to work with offline.
        prompt_tokens = sum(len(m.content) for m in request.messages) // 4
        completion_tokens = len(summary) // 4
        return LLMResponse(
            text=json.dumps(structured),
            provider=self.name,
            model=self._model,
            tokens_used=prompt_tokens + completion_tokens,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            structured=structured,
        )


def _extract_rows(prompt: str) -> list[dict]:
    start = prompt.find("[")
    end = prompt.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(prompt[start : end + 1])
    except json.JSONDecodeError:
        return []
    return [r for r in parsed if isinstance(r, dict)] if isinstance(parsed, list) else []


def _extract_question(prompt: str) -> str:
    match = re.search(r"Question:\s*(.+)", prompt)
    return match.group(1).strip() if match else ""
