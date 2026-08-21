"""Deterministic exact-match verifier tests (spec 0008: numbers, ids, dates,
totals verified exactly; the model-free half must not need a model at all)."""

from __future__ import annotations

from ledgerlens_judge.claims import split_claims
from ledgerlens_judge.verifiers import Chunk, Verdict, check_claim


def _claim(text: str):
    return split_claims(text, "c")[0]


def _chunks(*texts: str) -> tuple[Chunk, ...]:
    return tuple(Chunk(chunk_id=i, title=f"t{i}", text=text) for i, text in enumerate(texts))


def _verdict(text: str, chunks: tuple[Chunk, ...]):
    return check_claim(_claim(text), chunks)


def test_number_found_is_supported() -> None:
    verdict = _verdict(
        "The March total was $12,340.56.",
        _chunks("March revenue totaled $12,340.56 according to the ledger."),
    )
    assert verdict.verdict is Verdict.SUPPORTED
    assert verdict.method == "exact"


def test_number_missing_is_unsupported() -> None:
    verdict = _verdict(
        "The March total was $12,340.56.",
        _chunks("March revenue totaled $9,999.00 according to the ledger."),
    )
    assert verdict.verdict is Verdict.UNSUPPORTED
    assert verdict.method == "number"


def test_currency_thousands_separators_match_compact_form() -> None:
    verdict = _verdict("Revenue was $12,340.", _chunks("revenue: $12340"))
    assert verdict.verdict is Verdict.SUPPORTED


def test_percent_matches_percent_word() -> None:
    verdict = _verdict("The discount is 5%.", _chunks("we give a 5 percent discount"))
    assert verdict.verdict is Verdict.SUPPORTED


def test_percent_requires_the_unit() -> None:
    # The bare integer must not satisfy a percent claim ("5" in "5 items" is
    # not "5%").
    verdict = _verdict("The discount is 5%.", _chunks("we processed 5 items"))
    assert verdict.verdict is Verdict.UNSUPPORTED


def test_bare_small_integer_is_not_a_checkable_datum() -> None:
    verdict = _verdict("We found 2 invoices.", _chunks("the invoice ledger"))
    assert verdict.verdict is None
    assert verdict.method == "model"


def test_invoice_id_found_is_supported() -> None:
    verdict = _verdict(
        "Invoice INV-2043 was disputed.", _chunks("INV-2043 was disputed by the customer")
    )
    assert verdict.verdict is Verdict.SUPPORTED


def test_invoice_id_missing_is_unsupported() -> None:
    verdict = _verdict("Invoice INV-2043 was disputed.", _chunks("no invoice ids listed"))
    assert verdict.verdict is Verdict.UNSUPPORTED


def test_iso_date_found_is_supported() -> None:
    verdict = _verdict(
        "The invoice is due 2026-08-19.", _chunks("due date 2026-08-19 per the terms")
    )
    assert verdict.verdict is Verdict.SUPPORTED


def test_iso_date_missing_is_unsupported() -> None:
    verdict = _verdict(
        "The invoice is due 2026-08-19.", _chunks("due date 2026-08-20 per the terms")
    )
    assert verdict.verdict is Verdict.UNSUPPORTED


def test_month_day_year_matches_iso_context() -> None:
    verdict = _verdict("Closed on August 19, 2026.", _chunks("the close ran on 2026-08-19"))
    assert verdict.verdict is Verdict.SUPPORTED


def test_iso_date_matches_named_month_context() -> None:
    verdict = _verdict("Closed on 2026-08-19.", _chunks("the close ran on August 19, 2026"))
    assert verdict.verdict is Verdict.SUPPORTED


def test_multiple_checkables_all_must_be_present() -> None:
    chunks = _chunks("March revenue was $12,340.56 per the ledger")
    assert _verdict("March revenue was $12,340.56.", chunks).verdict is Verdict.SUPPORTED
    assert _verdict("March revenue was $12,340.99.", chunks).verdict is Verdict.UNSUPPORTED


def test_citation_restricts_context_to_the_cited_chunk() -> None:
    # The value is in the corpus but outside the cited chunk: ungrounded.
    chunks = _chunks("March total was $12,340.56", "an unrelated chunk")
    verdict = _verdict("The March total was $12,340.56 [chunk:1].", chunks)
    assert verdict.verdict is Verdict.UNSUPPORTED


def test_cited_chunk_not_retrieved_is_unsupported() -> None:
    verdict = _verdict("Revenue was $1,000 [chunk:99].", _chunks("nothing here"))
    assert verdict.verdict is Verdict.UNSUPPORTED
    assert verdict.method == "citation"


def test_invoice_citation_found_is_supported() -> None:
    verdict = _verdict("Paid [invoice:INV-2043] on time.", _chunks("INV-2043 was paid on time"))
    assert verdict.verdict is Verdict.SUPPORTED


def test_invoice_citation_not_retrieved_is_unsupported() -> None:
    verdict = _verdict("Paid [invoice:INV-9999] on time.", _chunks("INV-2043 was paid on time"))
    assert verdict.verdict is Verdict.UNSUPPORTED
    assert verdict.method == "citation"


def test_negation_contradicted_when_keyword_in_context() -> None:
    # The D-27 eval shape: "no invoices are currently overdue" must not pass
    # when the retrieved chunks mention overdue invoices.
    verdict = _verdict(
        "No invoices are currently overdue.",
        _chunks("invoice INV-2043 is overdue as of today"),
    )
    assert verdict.verdict is Verdict.CONTRADICTED
    assert verdict.method == "negation"


def test_negation_without_keyword_in_context_needs_model() -> None:
    verdict = _verdict(
        "No invoices are currently overdue.", _chunks("all invoices were paid on time")
    )
    assert verdict.verdict is None
    assert verdict.method == "model"


def test_label_value_conflict_is_contradicted() -> None:
    verdict = _verdict(
        "The total is $12,340.56.",
        _chunks("march total is $12,340.56; april total is $9,999.00"),
    )
    assert verdict.verdict is Verdict.CONTRADICTED
    assert verdict.method == "label"


def test_label_value_cooccurrence_is_supported() -> None:
    verdict = _verdict("The status is paid.", _chunks("status: paid"))
    assert verdict.verdict is Verdict.SUPPORTED
    assert verdict.method == "label"


def test_status_conflict_is_contradicted() -> None:
    verdict = _verdict("The status is paid.", _chunks("status: open"))
    assert verdict.verdict is Verdict.CONTRADICTED


def test_claim_without_checkables_or_signals_needs_model() -> None:
    verdict = _verdict("The report was thorough.", _chunks("the report covered many topics"))
    assert verdict.verdict is None
    assert verdict.method == "model"


def test_unresolvable_claim_never_returns_a_pass() -> None:
    # A claim the deterministic half cannot decide must not default to a pass.
    for text in ("The analysis was detailed.", "March looked strong overall."):
        assert _verdict(text, _chunks("some unrelated context")).verdict is None
