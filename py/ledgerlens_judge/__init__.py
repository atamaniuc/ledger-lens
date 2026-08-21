"""Claim-level groundedness judge for LedgerLens (spec 0008, D-27/D-03).

Two signals, deliberately stacked (spec 0008 invariants):
  1. the deterministic citation/exact-value check stays the first signal
     (src/features/agent/citations.ts);
  2. this judge is the second signal: every claim is checked against the
     retrieved chunks it was supposed to come from, and only the claims the
     deterministic half cannot resolve go to a model.
"""

from ledgerlens_judge.claims import Citation, Claim, split_claims
from ledgerlens_judge.judge import InputRecord, judge_case, judge_records
from ledgerlens_judge.model import (
    MAX_CHUNKS_PER_CLAIM,
    ModelClient,
    ModelVerdict,
    OpenAICompatibleJudge,
)
from ledgerlens_judge.report import REPORT_SCHEMA_VERSION, build_report, summarize
from ledgerlens_judge.verifiers import Chunk, Verdict, check_claim

__all__ = [
    "MAX_CHUNKS_PER_CLAIM",
    "REPORT_SCHEMA_VERSION",
    "Chunk",
    "Citation",
    "Claim",
    "InputRecord",
    "ModelClient",
    "ModelVerdict",
    "OpenAICompatibleJudge",
    "Verdict",
    "build_report",
    "check_claim",
    "judge_case",
    "judge_records",
    "split_claims",
    "summarize",
]
