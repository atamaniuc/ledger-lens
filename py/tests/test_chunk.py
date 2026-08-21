"""Chunker tests: golden-fixture parity with the TypeScript chunker, plus a
port of the TS unit suite (lib/rag/chunk.test.ts).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ledgerlens_indexer.chunk import (
    CHUNK_OVERLAP_CHARS,
    MAX_CHUNK_CHARS,
    chunk_text,
    hash_text,
    normalize,
    render_invoice,
    split_into_chunks,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def _opts(fx: dict) -> dict:
    if fx["opts"] is None:
        return {}
    return {"max_chars": fx["opts"]["maxChars"], "overlap_chars": fx["opts"]["overlapChars"]}


def _sentence(n: int) -> str:
    return f"Sentence number {n} says something about invoices and terms."


def _paragraph(count: int) -> str:
    return " ".join(_sentence(i) for i in range(count))


# --- Golden-fixture parity: the point of this lane -------------------------


def test_golden_split_matches_typescript_byte_for_byte() -> None:
    for fx in _load("golden_chunks.json"):
        assert split_into_chunks(fx["text"], **_opts(fx)) == fx["chunks"], fx["id"]


async def test_golden_chunk_text_matches_typescript_hashes() -> None:
    for fx in _load("golden_chunks.json"):
        chunks = await chunk_text(fx["text"], **_opts(fx))
        assert [c.content for c in chunks] == fx["chunks"], fx["id"]
        assert [c.content_hash for c in chunks] == fx["hashes"], fx["id"]


def test_golden_invoice_rendering_matches_typescript() -> None:
    for fx in _load("golden_invoices.json"):
        assert render_invoice(fx["invoice"]) == fx["rendered"], fx["id"]
        assert hash_text(fx["rendered"]) == fx["hash"], fx["id"]


# --- Ported TS unit suite --------------------------------------------------


def test_keeps_a_short_text_as_a_single_chunk() -> None:
    assert split_into_chunks("Net 30 from the invoice date.") == ["Net 30 from the invoice date."]


def test_returns_nothing_for_empty_or_whitespace_only_text() -> None:
    assert split_into_chunks("") == []
    assert split_into_chunks("   \n\t ") == []


def test_never_exceeds_the_chunk_ceiling() -> None:
    for chunk in split_into_chunks(_paragraph(80)):
        assert len(chunk) <= MAX_CHUNK_CHARS


def test_overlaps_consecutive_chunks() -> None:
    chunks = split_into_chunks(_paragraph(60))
    assert len(chunks) > 1
    tail = chunks[0][-CHUNK_OVERLAP_CHARS:]
    overlapping = any(len(word) > 3 and word in chunks[1] for word in tail.split(" "))
    assert overlapping


def test_is_deterministic() -> None:
    text = _paragraph(40)
    assert split_into_chunks(text) == split_into_chunks(text)


def test_is_insensitive_to_whitespace_noise() -> None:
    text = _paragraph(10)
    noisy = text.replace(" ", "  ").replace(".", ".\n")
    assert split_into_chunks(noisy) == split_into_chunks(text)


def test_loses_no_text_whatever_the_punctuation() -> None:
    text = (
        "Invoices are issued on Net 30 terms. Unpaid invoices accrue interest at "
        "1.5 percent per month. Escalate to collections after 60 days. Contact "
        "a.brown@example.com or ext. 4021 for exceptions!? Reference numbers "
        "look like INV-1.2 and must not be split."
    )
    joined = " ".join(split_into_chunks(text))
    for word in ["interest", "1.5", "a.brown@example.com", "ext.", "INV-1.2", "collections"]:
        assert word in joined
    # Nothing dropped: every non-space character survives the round trip.
    assert text.replace(" ", "") in joined.replace(" ", "")


def test_does_not_treat_a_decimal_point_as_a_sentence_end() -> None:
    assert split_into_chunks("Interest is 1.5 percent monthly.") == [
        "Interest is 1.5 percent monthly."
    ]


def test_hard_cuts_a_single_sentence_longer_than_the_ceiling() -> None:
    chunks = split_into_chunks("x" * 2500, max_chars=900, overlap_chars=100)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 900
    assert len("".join(chunks).replace(" ", "")) >= 2500


def test_makes_progress_when_the_overlap_alone_fills_a_chunk() -> None:
    chunks = split_into_chunks(_paragraph(20), max_chars=120, overlap_chars=110)
    assert len(chunks) > 1
    assert len(set(chunks)) == len(chunks)


def test_rejects_an_overlap_not_smaller_than_the_chunk() -> None:
    with pytest.raises(ValueError):
        split_into_chunks("text", max_chars=100, overlap_chars=100)


async def test_chunk_text_numbers_from_zero_and_hashes_each_one() -> None:
    chunks = await chunk_text(_paragraph(30))
    assert chunks[0].chunk_no == 0
    assert [c.chunk_no for c in chunks] == list(range(len(chunks)))
    for chunk in chunks:
        assert len(chunk.content_hash) == 64
        assert all(c in "0123456789abcdef" for c in chunk.content_hash)


async def test_identical_content_identical_hashes() -> None:
    (a,) = await chunk_text("Net 30 from the invoice date.")
    (b,) = await chunk_text("Net 30 from the invoice date.")
    assert a.content_hash == b.content_hash


def test_hash_text_matches_the_sql_seed_digest() -> None:
    # encode(sha256(convert_to('abc','UTF8')),'hex')
    assert hash_text("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_normalize_collapses_whitespace_and_trims() -> None:
    assert normalize("  a \n\n b\tc  ") == "a b c"


def test_utf16_code_units_match_javascript_lengths() -> None:
    # "🚀" is one code point but two UTF-16 code units; JS .length counts 2.
    # This exercises the emoji golden fixture end to end.
    fx = next(f for f in _load("golden_chunks.json") if f["id"] == "unicode-emoji")
    assert "🚀" in fx["text"]
    assert split_into_chunks(fx["text"]) == fx["chunks"]


def _base_invoice() -> dict:
    return {
        "external_id": "INV-2043",
        "customer": "Northwind Traders",
        "amount_cents": 120000,
        "currency": "usd",
        "status": "open",
        "issued_at": "2026-03-01",
        "paid_at": None,
    }


def test_render_invoice_names_the_things_a_person_would_type() -> None:
    text = render_invoice(_base_invoice())
    assert "INV-2043" in text
    assert "Northwind Traders" in text
    assert "1,200.00 USD" in text
    assert "Issued on 2026-03-01" in text


def test_render_invoice_mentions_payment_date_only_when_paid() -> None:
    assert "paid on" not in render_invoice(_base_invoice())
    paid = dict(_base_invoice(), status="paid", paid_at="2026-03-20")
    assert "paid on 2026-03-20" in render_invoice(paid)


def test_render_invoice_says_so_when_paid_without_a_date() -> None:
    paid = dict(_base_invoice(), status="paid", paid_at=None)
    assert "no payment date recorded" in render_invoice(paid)


async def test_render_invoice_is_one_chunk() -> None:
    assert len(await chunk_text(render_invoice(_base_invoice()))) == 1
