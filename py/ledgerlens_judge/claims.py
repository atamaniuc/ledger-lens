"""Claim decomposition for the groundedness judge (spec 0008, D-27).

An answer is split into checkable claims — one sentence each, with inline
citation markers ([chunk:n] / [invoice:...]) kept inside their sentence. Each
claim carries the citations it makes, which restrict the retrieved context it
may be checked against (verifiers.py).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Same marker syntax as src/features/agent/citations.ts.
_CITATION_RE = re.compile(r"\[(chunk|invoice):\s*([^\]\s][^\]]*?)\s*\]", re.IGNORECASE)

# Common abbreviations whose trailing period must not end a sentence
# ("e.g. 5%", "Jan. 2026", "Mr. Smith", "Inc."). Each becomes a fixed-width
# negative lookbehind in the sentence splitter below.
_ABBREVIATIONS = (
    "e.g",
    "i.e",
    "etc",
    "vs",
    "Mr",
    "Mrs",
    "Ms",
    "Dr",
    "St",
    "no",
    "No",
    "Inc",
    "Ltd",
    "Co",
    "Corp",
    "Fig",
    "approx",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "GMT",
    "UTC",
    "AM",
    "PM",
)
_ABBREV_GUARDS = "".join(rf"(?<!{re.escape(abbr)}\.)" for abbr in _ABBREVIATIONS)

# A sentence ends at . ! ? followed by whitespace and the start of a new
# sentence (a capital, digit, quote or citation marker), unless the period
# belongs to an abbreviation. Over-splitting is the safe direction for a
# judge: more, smaller claims, each checked on its own — under-splitting
# would let one ungrounded claim ride on a grounded neighbour.
_SENTENCE_SPLIT_RE = re.compile(
    rf"(?<=[.!?]){_ABBREV_GUARDS}\s+(?=[A-Z0-9\"'\u201c\u2018\[])",
)


@dataclass(frozen=True)
class Citation:
    kind: str  # "chunk" | "invoice"
    id: str  # as written by the model
    key: str  # f"{kind}:{id}"


@dataclass(frozen=True)
class Claim:
    id: str
    text: str
    citations: tuple[Citation, ...]
    # Offsets of the trimmed claim inside the original answer.
    start: int
    end: int


def _parse_citations(text: str) -> tuple[Citation, ...]:
    seen: list[Citation] = []
    for match in _CITATION_RE.finditer(text):
        kind = match.group(1).lower()
        cid = match.group(2).strip()
        key = f"{kind}:{cid}"
        if not any(c.key == key for c in seen):
            seen.append(Citation(kind=kind, id=cid, key=key))
    return tuple(seen)


def split_claims(answer: str, case_id: str) -> tuple[Claim, ...]:
    """Split an answer into claims; every claim id is prefixed by case_id."""
    claims: list[Claim] = []
    cursor = 0
    for match in _SENTENCE_SPLIT_RE.finditer(answer):
        _append_claim(claims, answer[cursor : match.start()], case_id, cursor)
        cursor = match.end()
    _append_claim(claims, answer[cursor:], case_id, cursor)
    return tuple(claims)


def _append_claim(claims: list[Claim], segment: str, case_id: str, cursor: int) -> None:
    text = segment.strip()
    if not text:
        return
    start = cursor + (len(segment) - len(segment.lstrip()))
    end = start + len(text)
    claims.append(
        Claim(
            id=f"{case_id}.{len(claims)}",
            text=text,
            citations=_parse_citations(text),
            start=start,
            end=end,
        )
    )
