"""Orchestration: split answers, check claims, consult the model for leftovers.

The deterministic half (verifiers.py) always runs first and needs no model;
only claims it cannot resolve go to the model half (model.py), and only when
one is configured — otherwise they are reported unscored and the run is
incomplete, never a silent pass.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from ledgerlens_judge.claims import Claim, split_claims
from ledgerlens_judge.config import ModelSpec
from ledgerlens_judge.model import (
    MAX_CHUNKS_PER_CLAIM,
    ModelClient,
    ModelClientError,
    ModelVerdict,
)
from ledgerlens_judge.verifiers import Chunk, Verdict, check_claim


class JudgeLogger(Protocol):
    def log(self, event: str, **fields: Any) -> None: ...


class _NoopLogger:
    def log(self, event: str, **fields: Any) -> None:
        return None


@dataclass(frozen=True)
class InputRecord:
    id: str
    answer: str
    retrieved: tuple[Chunk, ...]
    answerer: ModelSpec | None = None


@dataclass(frozen=True)
class ClaimResult:
    claim: Claim
    verdict: Verdict | None
    method: str
    evidence: tuple[str, ...] = ()
    unscored_reason: str | None = field(default=None)


@dataclass(frozen=True)
class CaseResult:
    id: str
    claims: tuple[ClaimResult, ...]


def judge_records(
    records: Sequence[InputRecord],
    *,
    model: ModelClient | None,
    logger: JudgeLogger,
    max_chunks_per_claim: int = MAX_CHUNKS_PER_CLAIM,
    model_unavailable_reason: str = "no model client configured",
) -> list[CaseResult]:
    return [
        judge_case(
            record,
            model,
            logger=logger,
            max_chunks_per_claim=max_chunks_per_claim,
            model_unavailable_reason=model_unavailable_reason,
        )
        for record in records
    ]


def judge_case(
    record: InputRecord,
    model: ModelClient | None,
    *,
    logger: JudgeLogger,
    max_chunks_per_claim: int = MAX_CHUNKS_PER_CLAIM,
    model_unavailable_reason: str = "no model client configured",
) -> CaseResult:
    claims = split_claims(record.answer, record.id)
    results = tuple(
        _judge_claim(
            claim,
            record.retrieved,
            model,
            logger,
            max_chunks_per_claim,
            model_unavailable_reason,
        )
        for claim in claims
    )
    return CaseResult(id=record.id, claims=results)


def _judge_claim(
    claim: Claim,
    chunks: Sequence[Chunk],
    model: ModelClient | None,
    logger: JudgeLogger,
    max_chunks_per_claim: int,
    model_unavailable_reason: str,
) -> ClaimResult:
    deterministic = check_claim(claim, chunks)
    if deterministic.verdict is not None:
        return ClaimResult(
            claim=claim,
            verdict=deterministic.verdict,
            method=deterministic.method,
            evidence=deterministic.evidence,
        )
    if model is None:
        return ClaimResult(
            claim=claim,
            verdict=None,
            method="model",
            unscored_reason=model_unavailable_reason,
        )
    try:
        verdict: ModelVerdict = model.judge(claim, list(chunks)[:max_chunks_per_claim])
        return ClaimResult(
            claim=claim,
            verdict=verdict.verdict,
            method="model",
            evidence=(verdict.reason,),
        )
    except ModelClientError as exc:
        logger.log("judge_model_failed", claim_id=claim.id, error=str(exc))
        return ClaimResult(
            claim=claim,
            verdict=None,
            method="model",
            unscored_reason=str(exc),
        )
