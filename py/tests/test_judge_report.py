"""Report schema and aggregation tests (the contract with evals/, spec 0008)."""

from __future__ import annotations

import json

from ledgerlens_judge.judge import InputRecord, judge_records
from ledgerlens_judge.model import ModelVerdict
from ledgerlens_judge.report import (
    REPORT_SCHEMA_VERSION,
    build_report,
    exit_code_for,
    summarize,
)
from ledgerlens_judge.verifiers import Chunk, Verdict


class _FakeModel:
    def judge(self, claim, chunks):  # type: ignore[no-untyped-def]
        return ModelVerdict(verdict=Verdict.UNSUPPORTED, reason="fake")


def _records() -> list[InputRecord]:
    return [
        InputRecord(
            id="c1",
            answer="The total is $12,340.56. The status is paid.",
            retrieved=(Chunk(1, "t", "the total is $12,340.56 and status is paid"),),
        ),
        InputRecord(
            id="c2",
            answer="The report was thorough.",
            retrieved=(Chunk(2, "t", "some unrelated context"),),
        ),
    ]


def _noop_logger():
    class _Noop:
        def log(self, event: str, **fields):  # type: ignore[no-untyped-def]
            return None

    return _Noop()


def test_summary_aggregation() -> None:
    results = judge_records(_records(), model=_FakeModel(), logger=_noop_logger())
    summary = summarize(results)
    assert summary["claims_total"] == 3
    assert summary["claims_supported"] == 2
    assert summary["claims_unsupported"] == 1
    assert summary["claims_contradicted"] == 0
    assert summary["claims_unscored"] == 0
    assert summary["deterministic"] == 2
    assert summary["model"] == 1
    assert summary["groundedness"] == 2 / 3
    assert summary["incomplete"] is False


def test_incomplete_when_claims_unscored() -> None:
    results = judge_records(_records(), model=None, logger=_noop_logger())
    summary = summarize(results)
    assert summary["claims_unscored"] == 1
    assert summary["incomplete"] is True
    assert summary["groundedness"] == 1.0  # scored over judged claims only


def test_incomplete_when_a_case_has_no_claims() -> None:
    results = judge_records(
        [InputRecord(id="empty", answer="", retrieved=(Chunk(1, "t", "x"),))],
        model=None,
        logger=_noop_logger(),
    )
    assert summarize(results)["incomplete"] is True


def test_report_schema_and_version() -> None:
    results = judge_records(_records(), model=None, logger=_noop_logger())
    report = build_report(
        correlation_id="cid-1",
        answerer=None,
        judge=None,
        cases=results,
        threshold=0.8,
        error=None,
    )
    assert report["schema_version"] == REPORT_SCHEMA_VERSION
    assert set(report) == {
        "schema_version",
        "generated_at",
        "correlation_id",
        "answerer",
        "judge",
        "summary",
        "threshold",
        "cases",
        "error",
    }
    assert report["correlation_id"] == "cid-1"
    assert report["answerer"] is None
    assert report["judge"] is None
    assert report["threshold"] == {"pass_at": 0.8, "breached": False}
    assert report["error"] is None
    assert len(report["cases"]) == 2
    claim = report["cases"][0]["claims"][0]
    assert set(claim) == {
        "id",
        "text",
        "cited",
        "citations",
        "method",
        "verdict",
        "evidence",
        "unscored_reason",
    }
    # JSON-serializable end to end
    json.dumps(report)


def test_report_threshold_breach() -> None:
    records = [
        InputRecord(
            id="c1",
            answer="The total is $12,340.56.",
            retrieved=(Chunk(1, "t", "the total is $9,999.00"),),
        )
    ]
    results = judge_records(records, model=None, logger=_noop_logger())
    report = build_report(
        correlation_id="c",
        answerer=None,
        judge=None,
        cases=results,
        threshold=0.95,
        error=None,
    )
    assert report["summary"]["groundedness"] == 0.0
    assert report["threshold"] == {"pass_at": 0.95, "breached": True}


def test_exit_codes() -> None:
    assert exit_code_for({"incomplete": False, "groundedness": 0.9}, 0.8) == 0
    assert exit_code_for({"incomplete": False, "groundedness": 0.7}, 0.8) == 1
    assert exit_code_for({"incomplete": True, "groundedness": 0.9}, 0.8) == 1
    assert exit_code_for({"incomplete": False, "groundedness": None}, None) == 0


def test_uncited_claims_are_counted() -> None:
    results = judge_records(_records(), model=_FakeModel(), logger=_noop_logger())
    summary = summarize(results)
    # None of the three claims carries a citation marker.
    assert summary["uncited_claims"] == 3
