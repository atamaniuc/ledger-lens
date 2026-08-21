"""Claim decomposition tests (spec 0008, D-27)."""

from __future__ import annotations

from ledgerlens_judge.claims import Citation, split_claims


def test_splits_answer_into_sentences() -> None:
    claims = split_claims("Revenue was $12,340 in March. Costs were $2,000.", "case-1")
    assert [c.text for c in claims] == [
        "Revenue was $12,340 in March.",
        "Costs were $2,000.",
    ]
    assert [c.id for c in claims] == ["case-1.0", "case-1.1"]


def test_citation_marker_does_not_split_a_sentence() -> None:
    claims = split_claims("Revenue was $12,340 [chunk:5] in March. Costs were $2,000.", "c")
    assert len(claims) == 2
    assert claims[0].citations == (Citation(kind="chunk", id="5", key="chunk:5"),)


def test_abbreviation_period_does_not_split() -> None:
    claims = split_claims("The discount is e.g. 5% of the total. March closed at $1,000.", "c")
    assert [c.text for c in claims] == [
        "The discount is e.g. 5% of the total.",
        "March closed at $1,000.",
    ]


def test_month_abbreviation_period_does_not_split() -> None:
    claims = split_claims("The period ended Jan. 2026. Revenue grew.", "c")
    assert [c.text for c in claims] == ["The period ended Jan. 2026.", "Revenue grew."]


def test_empty_answer_yields_no_claims() -> None:
    assert split_claims("", "c") == ()


def test_claims_carry_offsets_into_the_answer() -> None:
    claims = split_claims("First sentence. Second sentence.", "c")
    assert claims[0].start == 0
    assert claims[0].end == len("First sentence.")
    assert claims[1].start == len("First sentence. ")
    assert claims[1].end == len("First sentence. Second sentence.")


def test_citations_parsed_and_deduped() -> None:
    claims = split_claims("Paid [invoice:INV-2043] and again [invoice:INV-2043].", "c")
    assert len(claims) == 1
    assert [citation.key for citation in claims[0].citations] == ["invoice:INV-2043"]


def test_invoice_and_chunk_citations_kept_separate() -> None:
    claims = split_claims("Paid [invoice:INV-2043] [chunk:7].", "c")
    assert [citation.key for citation in claims[0].citations] == [
        "invoice:INV-2043",
        "chunk:7",
    ]
