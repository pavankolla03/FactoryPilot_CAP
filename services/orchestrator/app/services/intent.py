"""Resolve a natural-language question to a registered business object.

Keyword match first — deterministic, free, and tunable by a functional
consultant editing `keywords` in the admin UI. An LLM fallback exists behind a
flag for questions keywords miss (ADR-008).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.adapters.db.base import BusinessObject
from app.adapters.llm.base import LLMMessage, LLMProvider, LLMRequest


@dataclass(slots=True)
class IntentResult:
    object_code: str | None
    method: str  # keyword | llm | explicit | none
    score: int = 0


def match_keywords(question: str, objects: list[BusinessObject]) -> IntentResult:
    """Longest matching keyword wins.

    "sales order" must beat "order" when both are registered, or every sales
    question lands on whichever object happens to be first.
    """
    text = (question or "").lower()
    best: tuple[int, str] | None = None

    for obj in objects:
        for keyword in obj.keywords:
            if not keyword:
                continue
            # Word-boundary match so "order" does not fire inside "reorder".
            if re.search(rf"(?<!\w){re.escape(keyword)}(?!\w)", text):
                score = len(keyword)
                if best is None or score > best[0]:
                    best = (score, obj.object_code)

    if best:
        return IntentResult(object_code=best[1], method="keyword", score=best[0])
    return IntentResult(object_code=None, method="none")


async def classify_with_llm(
    question: str, objects: list[BusinessObject], llm: LLMProvider
) -> IntentResult:
    catalog = "\n".join(
        f"- {o.object_code}: {o.object_name} (keywords: {', '.join(o.keywords[:8])})"
        for o in objects
    )
    messages = [
        LLMMessage(
            role="system",
            content=(
                "You classify a user question to exactly one business object code. "
                "Reply with the code alone and nothing else. "
                "If none fit, reply NONE."
            ),
        ),
        LLMMessage(role="user", content=f"Objects:\n{catalog}\n\nQuestion: {question}"),
    ]
    response = await llm.complete(LLMRequest(messages=messages, max_tokens=16, temperature=0.0))
    guess = (response.text or "").strip().split()[0].strip(".,'\"").upper() if response.text.strip() else ""
    valid = {o.object_code for o in objects}
    if guess in valid:
        return IntentResult(object_code=guess, method="llm")
    return IntentResult(object_code=None, method="none")


async def resolve_intent(
    question: str,
    objects: list[BusinessObject],
    explicit_code: str | None = None,
    llm: LLMProvider | None = None,
    enable_llm_fallback: bool = False,
) -> IntentResult:
    valid = {o.object_code for o in objects}
    if explicit_code:
        code = explicit_code.upper()
        if code in valid:
            return IntentResult(object_code=code, method="explicit")
        return IntentResult(object_code=None, method="none")

    result = match_keywords(question, objects)
    if result.object_code or not (enable_llm_fallback and llm):
        return result
    return await classify_with_llm(question, objects, llm)
