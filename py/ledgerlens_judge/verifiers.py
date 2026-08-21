"""Deterministic exact-match verifiers — the model-free half of the judge.

Each verifier extracts checkable values (numbers, currency, ids, dates) from a
claim and looks them up in the retrieved context (spec 0008: "numbers, ids,
dates and totals can be verified exactly against the context, and that half
must not need a model at all"). Verdict semantics:

  supported      every checkable value appears in the retrieved context, or a
                 labelled attribute ("status is paid") co-occurs with its value
  unsupported    a checkable value is absent, or a cited chunk/invoice was not
                 retrieved
  contradicted   the context states a conflicting value for the same labelled
                 attribute, or the claim asserts a negation ("no invoices are
                 overdue") while the negated keyword appears in the context

A claim with no checkable value and no contradiction signal returns None — the
model half owns it (only the leftovers go to a model).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from ledgerlens_judge.claims import Claim


class Verdict(StrEnum):
    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"
    CONTRADICTED = "contradicted"


@dataclass(frozen=True)
class Chunk:
    chunk_id: int | str | None
    title: str
    text: str


@dataclass(frozen=True)
class DeterministicVerdict:
    verdict: Verdict | None
    method: str
    evidence: tuple[str, ...]


# --------------------------------------------------------------------------
# Value extraction
# --------------------------------------------------------------------------

_MONTHS = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}
_MONTH_PATTERN = (
    r"(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|"
    r"July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)"
)
_ISO_DATE_RE = re.compile(r"\b(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})\b")
_MONTH_DAY_YEAR_RE = re.compile(
    rf"\b(?P<month>{_MONTH_PATTERN})\.?\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?,?\s+(?P<year>\d{{4}})\b",
    re.IGNORECASE,
)
_DAY_MONTH_YEAR_RE = re.compile(
    rf"\b(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<month>{_MONTH_PATTERN})\.?\s+(?P<year>\d{{4}})\b",
    re.IGNORECASE,
)
_MONTH_YEAR_RE = re.compile(
    rf"\b(?P<month>{_MONTH_PATTERN})\.?\s+(?P<year>\d{{4}})\b",
    re.IGNORECASE,
)

# Numbers: currency prefix or unit optional; ids (INV-2043) are excluded by
# the leading lookbehind. A bare integer under 10 with no currency/unit is
# treated as answer scaffolding, not a checkable datum (see _checkables).
_NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9#_\-])"
    r"(?P<prefix>(?:USD|EUR|GBP|CAD|AUD|JPY|INR|kr|\$|€|£)\s*)?"
    r"(?P<num>(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)"
    r"(?P<unit>\s*(?:%|percent|USD|EUR|GBP|CAD|AUD|JPY|INR))?",
    re.IGNORECASE,
)

_ID_RE = re.compile(
    r"\b[A-Za-z]{2,6}-\d{2,}\b|"
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)

_NEGATION_RE = re.compile(r"\b(?:no|not|none|never|nothing|without|zero|n't)\b", re.IGNORECASE)

_LABELS = (
    "due date",
    "total",
    "amount",
    "revenue",
    "balance",
    "status",
    "count",
    "rate",
    "discount",
    "interest",
    "fee",
    "sum",
    "quantity",
)
_STATUS_WORDS = (
    "paid",
    "open",
    "draft",
    "void",
    "overdue",
    "active",
    "inactive",
    "cancelled",
    "pending",
    "approved",
    "rejected",
)
_LABEL_VALUE_RE = re.compile(
    r"\b(?P<label>due date|total|amount|revenue|balance|status|count|rate|"
    r"discount|interest|fee|sum|quantity)\b(?:'s)?\s*(?:is|was|were|"
    r"stands? at|totals?|:|=)\s*"
    r"(?P<value>\$?[0-9][0-9,]*(?:\.[0-9]+)?%?|\d{4}-\d{2}-\d{2}|"
    r"(?:paid|open|draft|void|overdue|active|inactive|cancelled|pending|approved|rejected))",
    re.IGNORECASE,
)

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")

# Words that never carry a claim's substance, including domain generics that
# appear in almost any retrieved context ("invoices", "payment") and would
# otherwise make every negation claim look contradicted.
_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "and",
        "or",
        "but",
        "if",
        "then",
        "than",
        "so",
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "with",
        "by",
        "from",
        "as",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "shall",
        "should",
        "can",
        "could",
        "may",
        "might",
        "must",
        "nor",
        "yet",
        "about",
        "above",
        "after",
        "before",
        "during",
        "between",
        "under",
        "over",
        "again",
        "further",
        "once",
        "here",
        "there",
        "when",
        "where",
        "why",
        "how",
        "all",
        "any",
        "both",
        "each",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "only",
        "own",
        "same",
        "very",
        "just",
        "now",
        "also",
        "still",
        "even",
        "much",
        "many",
        "into",
        "within",
        "out",
        "up",
        "down",
        "off",
        "invoice",
        "invoices",
        "payment",
        "payments",
        "document",
        "documents",
        "transaction",
        "transactions",
        "record",
        "records",
        "item",
        "items",
        "amount",
        "amounts",
        "number",
        "numbers",
        "thing",
        "things",
        "value",
        "values",
        "line",
        "lines",
        "entry",
        "entries",
        "row",
        "rows",
        "status",
        "count",
        "counts",
        "rate",
        "rates",
        "discount",
        "discounts",
        "fee",
        "fees",
        "interest",
        "balance",
        "revenue",
        "total",
        "totals",
        "currently",
        "today",
        "yesterday",
        "tomorrow",
        "this",
        "that",
        "these",
        "those",
        "which",
        "who",
        "whom",
        "whose",
        "while",
        "although",
        "though",
        "because",
        "since",
        "until",
    ]
)


@dataclass(frozen=True)
class Checkable:
    kind: str  # "number" | "date" | "id"
    literal: str  # as written in the claim
    variants: tuple[str, ...]  # literals to search for in the context
    method: str


def _number_variants(prefix: str, num: str, unit: str) -> tuple[str, ...]:
    compact = num.replace(",", "")
    p = prefix.strip().lower()
    u = unit.strip().lower()
    variants: set[str] = set()
    if u:
        variants.add(f"{compact}{u}")
        if u == "%":
            variants.add(f"{compact} percent")
        if p:
            variants.add(f"{p}{compact}{u}")
    elif p:
        variants.update({f"{p}{num}", f"{p}{compact}", compact, num})
    else:
        variants.update({num, compact})
    return tuple(sorted(variants, key=len, reverse=True))


def _date_variants(match: re.Match[str]) -> tuple[str, ...]:
    literal = match.group(0).strip()
    variants = {literal}
    groups = match.groupdict()
    month_name = (groups.get("month") or "").lower()
    day = groups.get("day")
    year = groups.get("year")
    month_num = _MONTHS.get(month_name)
    if month_num is not None and year:
        # Named-month form: add the ISO canonical rendering.
        if day:
            variants.add(f"{year}-{month_num:02d}-{int(day):02d}")
        else:
            variants.add(f"{year}-{month_num:02d}")
    elif groups.get("month") and groups.get("year") and groups.get("day"):
        # ISO form (year-month-day): add the named-month rendering.
        iso_month = groups["month"]
        iso_year = groups["year"]
        iso_day = groups["day"]
        name = next((n for n, m in _MONTHS.items() if m == int(iso_month) and len(n) > 3), "")
        if name:
            variants.add(f"{name.title()} {int(iso_day)}, {iso_year}")
            variants.add(f"{name.title()} {int(iso_day)} {iso_year}")
    return tuple(sorted(variants, key=len, reverse=True))


def _checkables(claim: Claim) -> tuple[Checkable, ...]:
    out: list[Checkable] = []
    seen: set[tuple[str, str]] = set()
    for match in _NUMBER_RE.finditer(claim.text):
        prefix = match.group("prefix") or ""
        num = match.group("num") or ""
        unit = match.group("unit") or ""
        if not unit and not prefix and "." not in num and "," not in num and int(num) < 10:
            continue  # answer scaffolding ("2 invoices"), not a datum
        literal = match.group(0).strip()
        key = ("number", literal)
        if key in seen:
            continue
        seen.add(key)
        out.append(Checkable("number", literal, _number_variants(prefix, num, unit), "number"))
    for match in _ISO_DATE_RE.finditer(claim.text):
        literal = match.group(0).strip()
        key = ("date", literal)
        if key in seen:
            continue
        seen.add(key)
        out.append(Checkable("date", literal, _date_variants(match), "date"))
    for match in _MONTH_DAY_YEAR_RE.finditer(claim.text):
        _append_date(out, seen, match)
    for match in _DAY_MONTH_YEAR_RE.finditer(claim.text):
        _append_date(out, seen, match)
    for match in _MONTH_YEAR_RE.finditer(claim.text):
        _append_date(out, seen, match)
    for match in _ID_RE.finditer(claim.text):
        literal = match.group(0).strip()
        key = ("id", literal)
        if key in seen:
            continue
        seen.add(key)
        out.append(Checkable("id", literal, (literal,), "id"))
    return tuple(out)


def _append_date(out: list[Checkable], seen: set[tuple[str, str]], match: re.Match[str]) -> None:
    literal = match.group(0).strip()
    key = ("date", literal)
    if key in seen:
        return
    seen.add(key)
    out.append(Checkable("date", literal, _date_variants(match), "date"))


# --------------------------------------------------------------------------
# Context resolution and lookup
# --------------------------------------------------------------------------


def _resolve_context(claim: Claim, chunks: Sequence[Chunk]) -> tuple[list[Chunk], list[str]]:
    """The chunks a claim may be checked against, and reasons anything is missing.

    A claim citing [chunk:n] / [invoice:x] is only grounded in the chunks it
    cites; a citation whose target was not retrieved is an unsupported claim,
    not a soft miss (spec 0008: "A claim without a citation is ungrounded,
    not unverified-but-fine").
    """
    chunk_cites = [c for c in claim.citations if c.kind == "chunk"]
    invoice_cites = [c for c in claim.citations if c.kind == "invoice"]
    if not chunk_cites and not invoice_cites:
        return list(chunks), []
    by_id = {str(c.chunk_id): c for c in chunks if c.chunk_id is not None}
    selected: list[Chunk] = []
    missing: list[str] = []
    for cite in chunk_cites:
        found = by_id.get(cite.id)
        if found is None:
            missing.append(f"cited chunk {cite.id} is not in the retrieved set")
        elif found not in selected:
            selected.append(found)
    for cite in invoice_cites:
        matches = [c for c in chunks if cite.id in c.text]
        if not matches:
            missing.append(f"cited invoice {cite.id} is not in the retrieved chunks")
        else:
            for chunk in matches:
                if chunk not in selected:
                    selected.append(chunk)
    return selected, missing


def _contains_literal(literal: str, context: str, *, digits: bool) -> bool:
    if digits:
        return re.search(rf"(?<![0-9]){re.escape(literal)}(?![0-9])", context) is not None
    return literal.lower() in context.lower()


def _found(checkable: Checkable, context: str) -> bool:
    if checkable.kind == "id":
        return re.search(rf"\b{re.escape(checkable.literal)}\b", context, re.IGNORECASE) is not None
    for variant in checkable.variants:
        if _contains_literal(variant, context, digits=checkable.kind == "number"):
            return True
    return False


def _negation_keywords(text: str) -> tuple[str, ...]:
    words = (w.lower() for w in _WORD_RE.findall(text))
    return tuple(dict.fromkeys(w for w in words if w not in _STOPWORDS))


def _canonical_value(value: str) -> str:
    v = value.strip()
    if v and (v[0] in "$€£" or v[0].isdigit()):
        return re.sub(r"[^0-9.]", "", v)
    return v.lower()


def _values_in_window(window: str) -> tuple[str, ...]:
    values: list[str] = []
    for match in _NUMBER_RE.finditer(window):
        num = match.group("num") or ""
        values.append(re.sub(r"[^0-9.]", "", num))
    for match in _ISO_DATE_RE.finditer(window):
        values.append(match.group(0))
    for word in _STATUS_WORDS:
        if re.search(rf"\b{word}\b", window, re.IGNORECASE):
            values.append(word)
    return tuple(dict.fromkeys(values))


def _label_conflict(claim: Claim, context: str, *, window: int) -> str | None:
    for match in _LABEL_VALUE_RE.finditer(claim.text):
        label = match.group("label").lower()
        value = match.group("value")
        canonical = _canonical_value(value)
        for label_match in re.finditer(re.escape(label), context, re.IGNORECASE):
            win = context[label_match.end() : label_match.end() + window]
            if _contains_literal(value, win, digits=value[:1].isdigit() or value[:1] == "$"):
                continue  # this occurrence agrees with the claim
            for candidate in _values_in_window(win):
                if candidate != canonical:
                    excerpt = " ".join(win.split())[:110]
                    return (
                        f"context states '{label} … {candidate}' near '{excerpt}', "
                        f"contradicting claim value '{value}'"
                    )
    return None


def _label_value_found(claim: Claim, context: str, *, window: int) -> bool:
    """Every labelled attribute in the claim co-occurs with its value in context."""
    pairs = list(_LABEL_VALUE_RE.finditer(claim.text))
    if not pairs:
        return False
    for match in pairs:
        label = match.group("label").lower()
        value = match.group("value")
        found_pair = False
        for label_match in re.finditer(re.escape(label), context, re.IGNORECASE):
            win = context[label_match.end() : label_match.end() + window]
            if _contains_literal(value, win, digits=value[:1].isdigit() or value[:1] == "$"):
                found_pair = True
                break
        if not found_pair:
            return False
    return True


def _support_evidence(
    checkables: Sequence[Checkable], restricted: Sequence[Chunk]
) -> tuple[str, ...]:
    evidence: list[str] = []
    for checkable in checkables[:3]:
        for chunk in restricted:
            if _found(checkable, chunk.text):
                excerpt = " ".join(chunk.text.split())[:80]
                where = f"chunk {chunk.chunk_id or '?'}"
                evidence.append(f"'{checkable.literal}' found in {where}: {excerpt}")
                break
    return tuple(evidence)


# --------------------------------------------------------------------------
# The deterministic decision
# --------------------------------------------------------------------------


def check_claim(
    claim: Claim, chunks: Sequence[Chunk], *, label_window: int = 80
) -> DeterministicVerdict:
    restricted, missing = _resolve_context(claim, chunks)
    if missing:
        return DeterministicVerdict(Verdict.UNSUPPORTED, "citation", tuple(missing))
    context = "\n".join(chunk.text for chunk in restricted)

    # 1. A negated claim is contradicted when the negated keyword is in the
    #    context ("no invoices are overdue" + a chunk mentioning overdue).
    if _NEGATION_RE.search(claim.text):
        keywords = _negation_keywords(claim.text)
        lowered = context.lower()
        for keyword in keywords:
            if keyword in lowered:
                return DeterministicVerdict(
                    Verdict.CONTRADICTED,
                    "negation",
                    (
                        f"claim asserts no '{keyword}' but the retrieved chunks mention it: "
                        f"{_excerpt_around(keyword, context)}",
                    ),
                )
        # A negative the context does not mention is neither supportable nor
        # refutable without a model.
        return DeterministicVerdict(None, "model", ())

    # 2. Exact values: numbers, currency, ids, dates, totals.
    checkables = _checkables(claim)
    if checkables:
        absent = [c for c in checkables if not _found(c, context)]
        if absent:
            return DeterministicVerdict(
                Verdict.UNSUPPORTED,
                absent[0].method,
                (f"value '{absent[0].literal}' is not present in the retrieved chunks",),
            )

    # 3. Labelled attributes: a conflicting labelled value overrides, a
    #    co-occurring pair supports.
    conflict = _label_conflict(claim, context, window=label_window)
    if conflict is not None:
        return DeterministicVerdict(Verdict.CONTRADICTED, "label", (conflict,))
    if checkables:
        return DeterministicVerdict(
            Verdict.SUPPORTED, "exact", _support_evidence(checkables, restricted)
        )
    if _label_value_found(claim, context, window=label_window):
        return DeterministicVerdict(
            Verdict.SUPPORTED,
            "label",
            ("labelled attribute and value co-occur in the retrieved chunks",),
        )

    # Nothing deterministic — the model half owns this claim.
    return DeterministicVerdict(None, "model", ())


def _excerpt_around(keyword: str, context: str) -> str:
    idx = context.lower().find(keyword)
    if idx < 0:
        return ""
    start = max(0, idx - 40)
    end = min(len(context), idx + len(keyword) + 40)
    return "…" + " ".join(context[start:end].split()) + "…"
