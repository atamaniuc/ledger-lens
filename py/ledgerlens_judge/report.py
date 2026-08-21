"""Report schema for the groundedness judge (consumed by evals/, spec 0008).

The schema is the contract with the eval runner: versioned, so a schema
change cannot be mistaken for a score change. The runner gates on
summary.groundedness (>= its threshold) and fails when summary.incomplete is
true — a run that did not judge everything is not a pass (mirrors the
NOT-MEASURED rule in evals/run.ts).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from ledgerlens_judge.config import ModelSpec
from ledgerlens_judge.judge import CaseResult, ClaimResult
from ledgerlens_judge.verifiers import Verdict

REPORT_SCHEMA_VERSION = "1.0"


def summarize(cases: Sequence[CaseResult]) -> dict[str, Any]:
    total = scored = supported = unsupported = contradicted = unscored = 0
    deterministic = model = uncited = 0
    empty_cases = 0
    for case in cases:
        if not case.claims:
            empty_cases += 1
        for claim in case.claims:
            total += 1
            if not claim.claim.citations:
                uncited += 1
            if claim.method == "model":
                model += 1
            else:
                deterministic += 1
            if claim.verdict is None:
                unscored += 1
            else:
                scored += 1
                if claim.verdict is Verdict.SUPPORTED:
                    supported += 1
                elif claim.verdict is Verdict.UNSUPPORTED:
                    unsupported += 1
                elif claim.verdict is Verdict.CONTRADICTED:
                    contradicted += 1
    groundedness: float | None = supported / scored if scored else None
    return {
        "claims_total": total,
        "claims_scored": scored,
        "claims_supported": supported,
        "claims_unsupported": unsupported,
        "claims_contradicted": contradicted,
        "claims_unscored": unscored,
        "deterministic": deterministic,
        "model": model,
        "uncited_claims": uncited,
        "groundedness": groundedness,
        "incomplete": unscored > 0 or empty_cases > 0 or total == 0,
    }


def build_report(
    *,
    correlation_id: str,
    answerer: ModelSpec | None,
    judge: ModelSpec | None,
    cases: Sequence[CaseResult],
    threshold: float | None,
    error: str | None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    summary = summarize(cases)
    breached: bool | None = None
    if threshold is not None and summary["groundedness"] is not None:
        breached = bool(summary["groundedness"] < threshold)
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_at": generated_at or datetime.now(UTC).isoformat(),
        "correlation_id": correlation_id,
        "answerer": _spec_dict(answerer),
        "judge": _spec_dict(judge),
        "summary": summary,
        "threshold": (
            {"pass_at": threshold, "breached": breached} if threshold is not None else None
        ),
        "cases": [_case_dict(case) for case in cases],
        "error": error,
    }


def exit_code_for(summary: dict[str, Any], threshold: float | None) -> int:
    """0 = complete and at/above threshold; 1 = incomplete or breached.

    Config errors are exit 2 and are raised before a summary exists.
    """
    if summary["incomplete"]:
        return 1
    if (
        threshold is not None
        and summary["groundedness"] is not None
        and summary["groundedness"] < threshold
    ):
        return 1
    return 0


def _spec_dict(spec: ModelSpec | None) -> dict[str, str] | None:
    if spec is None:
        return None
    return {"provider": spec.provider, "model": spec.model}


def _case_dict(case: CaseResult) -> dict[str, Any]:
    return {"id": case.id, "claims": [_claim_dict(claim) for claim in case.claims]}


def _claim_dict(claim: ClaimResult) -> dict[str, Any]:
    return {
        "id": claim.claim.id,
        "text": claim.claim.text,
        "cited": bool(claim.claim.citations),
        "citations": [
            {"kind": citation.kind, "id": citation.id} for citation in claim.claim.citations
        ],
        "method": claim.method,
        "verdict": claim.verdict.value if claim.verdict is not None else None,
        "evidence": list(claim.evidence),
        "unscored_reason": claim.unscored_reason,
    }
