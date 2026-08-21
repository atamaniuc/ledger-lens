"""ledgerlens-judge — claim-level groundedness, spec 0008 (D-27, D-03).

Usage:
    ledgerlens-judge --input cases.jsonl [--output evals/groundedness.json]
                     [--threshold 0.8]

Exit codes:
    0  every claim judged and the score is at/above --threshold (when given)
    1  claims went unjudged (no JUDGE_API_KEY, model errors) or the score
       breached --threshold — a gate that cannot judge is red, not green
    2  configuration or input error (judge would grade itself, unknown
       provider, unreadable input)

Environment (new keys, to be added to src/platform/config.ts by the parent):
    JUDGE_PROVIDER  groq (default) | nvidia | openai-compatible — never
                    anthropic: no free tier, no OpenAI-compatible endpoint
    JUDGE_MODEL     the judging model (required)
    JUDGE_API_KEY   the judging provider's key (required when the model half
                    runs; absent ⇒ loud non-zero skip, never a silent pass)
    JUDGE_BASE_URL  only for JUDGE_PROVIDER=openai-compatible
    LLM_PROVIDER / LLM_MODEL — the answering model, for the judge-must-differ
                    guard (may be supplied per-record or via --answerer-*)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections.abc import Sequence
from typing import Any

from ledgerlens_judge.config import (
    JudgeConfigError,
    ModelSpec,
    assert_judge_differs,
    resolve_answerer,
    resolve_judge,
)
from ledgerlens_judge.judge import CaseResult, InputRecord, judge_records
from ledgerlens_judge.logging import JsonLogger
from ledgerlens_judge.model import MAX_CHUNKS_PER_CLAIM, OpenAICompatibleJudge
from ledgerlens_judge.report import build_report, exit_code_for, summarize
from ledgerlens_judge.verifiers import Chunk

DEFAULT_OUTPUT = "evals/groundedness.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ledgerlens-judge",
        description="Score claim-level groundedness of agent answers against "
        "retrieved chunks (spec 0008). Deterministic exact-value checks first; "
        "only the leftovers go to a model.",
    )
    parser.add_argument("--input", required=True, help="JSONL of cases: one record per line")
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"report path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="fail (exit 1) when summary.groundedness is below this (0..1)",
    )
    parser.add_argument("--correlation-id", default=None, help="carried on every log line")
    parser.add_argument("--answerer-provider", default=None, help="answering provider (guard)")
    parser.add_argument("--answerer-model", default=None, help="answering model (guard)")
    parser.add_argument("--judge-provider", default=None, help="defaults to JUDGE_PROVIDER or groq")
    parser.add_argument("--judge-model", default=None, help="defaults to JUDGE_MODEL")
    parser.add_argument("--judge-api-key", default=None, help="defaults to JUDGE_API_KEY")
    parser.add_argument("--judge-base-url", default=None, help="defaults to JUDGE_BASE_URL")
    parser.add_argument(
        "--max-chunks-per-claim",
        type=int,
        default=MAX_CHUNKS_PER_CLAIM,
        help="chunks shown to the model per claim",
    )
    return parser


def _load_records(path: str) -> list[InputRecord]:
    try:
        with open(path, encoding="utf-8") as handle:
            lines = [line for line in handle if line.strip()]
    except OSError as exc:
        raise ValueError(f"cannot read input {path}: {exc}") from exc
    if not lines:
        raise ValueError(f"input {path} is empty")
    records: list[InputRecord] = []
    for number, line in enumerate(lines, start=1):
        where = f"{path}:{number}"
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{where}: not valid JSON: {exc}") from exc
        records.append(_parse_record(raw, where))
    return records


def _parse_record(raw: Any, where: str) -> InputRecord:
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: record must be a JSON object")
    record_id = raw.get("id")
    answer = raw.get("answer")
    retrieved = raw.get("retrieved")
    if not isinstance(record_id, str) or not record_id:
        raise ValueError(f"{where}: record needs a non-empty string id")
    if not isinstance(answer, str):
        raise ValueError(f"{where}: record {record_id!r} needs a string answer")
    if not isinstance(retrieved, list) or not retrieved:
        raise ValueError(f"{where}: record {record_id!r} needs a non-empty retrieved[] array")
    chunks: list[Chunk] = []
    for index, chunk in enumerate(retrieved):
        if not isinstance(chunk, dict) or not isinstance(chunk.get("text"), str):
            raise ValueError(
                f"{where}: record {record_id!r} retrieved[{index}] needs a text string"
            )
        chunk_id = chunk.get("chunk_id")
        if chunk_id is not None and not isinstance(chunk_id, (int, str)):
            raise ValueError(
                f"{where}: record {record_id!r} retrieved[{index}] chunk_id must be int/str"
            )
        chunks.append(
            Chunk(
                chunk_id=chunk_id,
                title=str(chunk.get("title") or ""),
                text=chunk["text"],
            )
        )
    return InputRecord(
        id=record_id,
        answer=answer,
        retrieved=tuple(chunks),
        answerer=_parse_answerer(raw.get("answerer")),
    )


def _parse_answerer(raw: Any) -> ModelSpec | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("answerer must be an object {provider, model}")
    provider = str(raw.get("provider") or "").strip().lower()
    model = str(raw.get("model") or "").strip()
    if not provider or not model:
        raise ValueError("answerer needs provider and model")
    return ModelSpec(provider=provider, model=model)


def _write_report(path: str, report: dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    correlation_id = args.correlation_id or str(uuid.uuid4())
    log = JsonLogger(correlation_id)
    env = dict(os.environ)

    cli_answerer: ModelSpec | None = None
    if args.answerer_provider or args.answerer_model:
        cli_answerer = ModelSpec(
            provider=args.answerer_provider or "",
            model=args.answerer_model or "",
        )

    judge_env = dict(env)
    if args.judge_provider:
        judge_env["JUDGE_PROVIDER"] = args.judge_provider
    if args.judge_model:
        judge_env["JUDGE_MODEL"] = args.judge_model
    if args.judge_api_key:
        judge_env["JUDGE_API_KEY"] = args.judge_api_key
    if args.judge_base_url:
        judge_env["JUDGE_BASE_URL"] = args.judge_base_url

    try:
        records = _load_records(args.input)
    except ValueError as exc:
        log.log("judge_input_error", error=str(exc))
        report = build_report(
            correlation_id=correlation_id,
            answerer=None,
            judge=None,
            cases=[],
            threshold=args.threshold,
            error=str(exc),
        )
        _write_report(args.output, report)
        return 2

    cases: list[CaseResult] = []
    judge_spec: ModelSpec | None = None
    answerer_spec: ModelSpec | None = None
    try:
        # Phase 1 — deterministic judgement of every claim, no model.
        cases = judge_records(
            records,
            model=None,
            logger=log,
            max_chunks_per_claim=args.max_chunks_per_claim,
            model_unavailable_reason="JUDGE_API_KEY is not set",
        )
        model_bound = any(claim.verdict is None for case in cases for claim in case.claims)
        if model_bound:
            judge_spec = resolve_judge(judge_env)
            seen_warnings: set[tuple[str, str]] = set()
            for record, case in zip(records, cases, strict=True):
                if not any(claim.verdict is None for claim in case.claims):
                    continue
                answerer = record.answerer or cli_answerer or resolve_answerer(env)
                warning = assert_judge_differs(judge_spec, answerer)
                if (
                    answerer is not None
                    and warning is not None
                    and (answerer.provider, answerer.model) not in seen_warnings
                ):
                    log.log("judge_same_provider", warning=warning)
                    seen_warnings.add((answerer.provider, answerer.model))
                answerer_spec = answerer_spec or answerer
            if judge_spec.api_key:
                client = OpenAICompatibleJudge(
                    base_url=judge_spec.base_url or "",
                    api_key=judge_spec.api_key,
                    model=judge_spec.model,
                )
                # Phase 2 — rerun so model-bound claims get a verdict (or an
                # unscored reason when the provider refuses).
                cases = judge_records(
                    records,
                    model=client,
                    logger=log,
                    max_chunks_per_claim=args.max_chunks_per_claim,
                )
            else:
                log.log(
                    "judge_model_unavailable",
                    error="JUDGE_API_KEY is not set; refusing to report a pass",
                    model_bound=model_bound,
                )
        summary = summarize(cases)
        if summary["incomplete"]:
            log.log(
                "judge_incomplete",
                claims_unscored=summary["claims_unscored"],
                claims_total=summary["claims_total"],
            )
        report = build_report(
            correlation_id=correlation_id,
            answerer=answerer_spec,
            judge=judge_spec,
            cases=cases,
            threshold=args.threshold,
            error=None,
        )
        _write_report(args.output, report)
        return exit_code_for(summary, args.threshold)
    except JudgeConfigError as exc:
        log.log("judge_config_error", error=str(exc))
        report = build_report(
            correlation_id=correlation_id,
            answerer=answerer_spec,
            judge=judge_spec,
            cases=cases,
            threshold=args.threshold,
            error=str(exc),
        )
        _write_report(args.output, report)
        return 2
    except OSError as exc:
        log.log("judge_write_error", error=str(exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
