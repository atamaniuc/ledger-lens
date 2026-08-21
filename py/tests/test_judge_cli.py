"""End-to-end CLI tests: input JSONL, report file, exit codes. No network, no DB."""

from __future__ import annotations

import json

from ledgerlens_judge.cli import main

GOOD_CASE = {
    "id": "met-01",
    "answer": "The total is $12,340.56.",
    "retrieved": [{"chunk_id": 1, "title": "t", "text": "the total is $12,340.56"}],
}

MODEL_BOUND_CASE = {
    "id": "met-02",
    "answer": "The report was thorough.",
    "retrieved": [{"chunk_id": 1, "title": "t", "text": "some unrelated context"}],
}


def _write_cases(tmp_path, cases) -> str:
    path = tmp_path / "cases.jsonl"
    path.write_text("\n".join(json.dumps(case) for case in cases) + "\n", encoding="utf-8")
    return str(path)


def _run(tmp_path, cases, *extra: str) -> tuple[int, dict]:
    out = tmp_path / "report.json"
    argv = [
        "--input",
        _write_cases(tmp_path, cases),
        "--output",
        str(out),
        "--correlation-id",
        "test-cid",
        *extra,
    ]
    code = main(argv)
    return code, json.loads(out.read_text(encoding="utf-8"))


def test_deterministic_only_run_exits_zero(tmp_path) -> None:
    code, report = _run(tmp_path, [GOOD_CASE])
    assert code == 0
    assert report["summary"]["groundedness"] == 1.0
    assert report["summary"]["incomplete"] is False
    assert report["judge"] is None  # no model half needed
    assert report["error"] is None
    assert report["correlation_id"] == "test-cid"


def test_report_default_output_path(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    inp = _write_cases(tmp_path, [GOOD_CASE])
    assert main(["--input", inp]) == 0
    assert (tmp_path / "evals" / "groundedness.json").exists()


def test_model_bound_claims_without_key_exit_one(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_MODEL", "gpt-oss-20b")
    monkeypatch.setenv("JUDGE_PROVIDER", "groq")
    monkeypatch.setenv("JUDGE_MODEL", "llama-3.3-70b-versatile")
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    code, report = _run(tmp_path, [MODEL_BOUND_CASE])
    assert code == 1
    assert report["summary"]["incomplete"] is True
    assert report["summary"]["claims_unscored"] == 1
    assert report["summary"]["groundedness"] is None  # nothing was scored
    assert report["judge"] == {"provider": "groq", "model": "llama-3.3-70b-versatile"}
    assert report["error"] is None


def test_judge_equal_to_answerer_exits_two(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_MODEL", "gpt-oss-20b")
    monkeypatch.setenv("JUDGE_PROVIDER", "groq")
    monkeypatch.setenv("JUDGE_MODEL", "gpt-oss-20b")
    monkeypatch.setenv("JUDGE_API_KEY", "k")
    code, report = _run(tmp_path, [MODEL_BOUND_CASE])
    assert code == 2
    assert report["error"] is not None
    assert "judge itself" in report["error"]


def test_record_answerer_is_used_for_the_guard(tmp_path, monkeypatch) -> None:
    # The record names its own answerer; the guard compares against it.
    monkeypatch.setenv("JUDGE_PROVIDER", "groq")
    monkeypatch.setenv("JUDGE_MODEL", "llama-3.3-70b-versatile")
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    case = dict(MODEL_BOUND_CASE, answerer={"provider": "groq", "model": "gpt-oss-20b"})
    code, report = _run(tmp_path, [case])
    assert code == 1  # incomplete (no key), but the guard passed
    assert report["answerer"] == {"provider": "groq", "model": "gpt-oss-20b"}


def test_threshold_breach_exits_one(tmp_path) -> None:
    bad_case = {
        "id": "met-03",
        "answer": "The total is $12,340.56.",
        "retrieved": [{"chunk_id": 1, "title": "t", "text": "the total is $9,999.00"}],
    }
    code, report = _run(tmp_path, [bad_case], "--threshold", "0.8")
    assert code == 1
    assert report["threshold"] == {"pass_at": 0.8, "breached": True}
    assert report["summary"]["groundedness"] == 0.0


def test_threshold_met_exits_zero(tmp_path) -> None:
    code, report = _run(tmp_path, [GOOD_CASE], "--threshold", "0.8")
    assert code == 0
    assert report["threshold"]["breached"] is False


def test_bad_input_exits_two(tmp_path) -> None:
    path = tmp_path / "bad.jsonl"
    path.write_text("{not json\n", encoding="utf-8")
    out = tmp_path / "report.json"
    assert main(["--input", str(path), "--output", str(out)]) == 2
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["error"] is not None


def test_missing_input_file_exits_two(tmp_path) -> None:
    assert (
        main(["--input", str(tmp_path / "nope.jsonl"), "--output", str(tmp_path / "r.json")]) == 2
    )


def test_record_without_retrieved_array_is_rejected(tmp_path) -> None:
    path = tmp_path / "cases.jsonl"
    path.write_text(json.dumps({"id": "x", "answer": "hi"}) + "\n", encoding="utf-8")
    assert main(["--input", str(path), "--output", str(tmp_path / "r.json")]) == 2


def test_evidence_is_recorded_per_claim(tmp_path) -> None:
    code, report = _run(tmp_path, [GOOD_CASE])
    assert code == 0
    claim = report["cases"][0]["claims"][0]
    assert claim["verdict"] == "supported"
    assert claim["method"] == "exact"
    assert claim["evidence"][0].startswith("'$12,340.56' found in chunk 1:")


def test_negation_eval_shape_cannot_pass(tmp_path, monkeypatch) -> None:
    # The D-27 eval shape: "no invoices are currently overdue" with a chunk
    # that mentions overdue — the judge must flag it, and the gate must go red.
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_MODEL", "gpt-oss-20b")
    monkeypatch.setenv("JUDGE_PROVIDER", "groq")
    monkeypatch.setenv("JUDGE_MODEL", "llama-3.3-70b-versatile")
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    case = {
        "id": "una-overdue",
        "answer": "No invoices are currently overdue.",
        "retrieved": [
            {"chunk_id": 1, "title": "t", "text": "invoice INV-2043 is overdue as of today"}
        ],
    }
    code, report = _run(tmp_path, [case], "--threshold", "0.8")
    assert report["cases"][0]["claims"][0]["verdict"] == "contradicted"
    assert code == 1  # groundedness 0.0 < 0.8


def test_uncited_claim_cannot_verify_cleanly(tmp_path, monkeypatch) -> None:
    # Same shape but the context does not mention overdue: the claim needs the
    # model; with no key the run is incomplete and exits non-zero — never a pass.
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_MODEL", "gpt-oss-20b")
    monkeypatch.setenv("JUDGE_PROVIDER", "groq")
    monkeypatch.setenv("JUDGE_MODEL", "llama-3.3-70b-versatile")
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    case = {
        "id": "una-overdue",
        "answer": "No invoices are currently overdue.",
        "retrieved": [{"chunk_id": 1, "title": "t", "text": "all invoices were paid on time"}],
    }
    code, report = _run(tmp_path, [case])
    assert code == 1
    assert report["summary"]["incomplete"] is True
