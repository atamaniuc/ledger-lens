"""Model-half tests: the OpenAI-compatible client and its mockability.

All HTTP is faked with httpx.MockTransport — no live provider, no key.
"""

from __future__ import annotations

import json

import httpx
import pytest

from ledgerlens_judge.claims import split_claims
from ledgerlens_judge.judge import InputRecord, judge_records
from ledgerlens_judge.model import (
    ModelClientError,
    ModelVerdict,
    OpenAICompatibleJudge,
)
from ledgerlens_judge.verifiers import Chunk, Verdict

BASE = "https://api.groq.com/openai/v1"

FENCE = "`" * 3
NL = chr(10)


def _judge(handler, **kwargs) -> OpenAICompatibleJudge:
    kwargs.setdefault("retry_base_s", 0.001)
    kwargs.setdefault("rng", lambda: 0.5)
    return OpenAICompatibleJudge(
        base_url=BASE,
        api_key="test-key",
        model="llama-3.3-70b-versatile",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def _claim(text: str):
    return split_claims(text, "c")[0]


def _json_response(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_judge_parses_supported_verdict() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "llama-3.3-70b-versatile"
        assert body["temperature"] == 0
        assert "CLAIM:" in body["messages"][1]["content"]
        return _json_response('{"verdict": "supported", "reason": "chunk 1 states the total"}')

    judge = _judge(handler)
    verdict = judge.judge(
        _claim("The total is $12,340.56."), [Chunk(1, "t", "the total is $12,340.56")]
    )
    assert verdict == ModelVerdict(verdict=Verdict.SUPPORTED, reason="chunk 1 states the total")


def test_judge_parses_verdict_from_fenced_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        fenced = FENCE + "json" + NL + '{"verdict": "unsupported", "reason": "absent"}' + NL + FENCE
        return _json_response(fenced)

    judge = _judge(handler)
    verdict = judge.judge(_claim("Anything at all."), [Chunk(1, "t", "text")])
    assert verdict.verdict is Verdict.UNSUPPORTED


def test_judge_retries_on_429_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": {"message": "rate limited"}})
        return _json_response('{"verdict": "contradicted", "reason": "conflict"}')

    judge = _judge(handler, max_retries=2)
    verdict = judge.judge(_claim("X."), [Chunk(1, "t", "text")])
    assert verdict.verdict is Verdict.CONTRADICTED
    assert calls["n"] == 2


def test_judge_raises_after_retries_exhausted() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "still limited"}})

    judge = _judge(handler, max_retries=1)
    with pytest.raises(ModelClientError, match="after 2 attempts"):
        judge.judge(_claim("X."), [Chunk(1, "t", "text")])


def test_judge_raises_on_permanent_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad request")

    judge = _judge(handler)
    with pytest.raises(ModelClientError, match="HTTP 400"):
        judge.judge(_claim("X."), [Chunk(1, "t", "text")])


def test_judge_raises_on_garbage_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_response("not json at all")

    judge = _judge(handler)
    with pytest.raises(ModelClientError, match="no JSON object"):
        judge.judge(_claim("X."), [Chunk(1, "t", "text")])


def test_judge_raises_on_unknown_verdict() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_response('{"verdict": "maybe", "reason": "?"}')

    judge = _judge(handler)
    with pytest.raises(ModelClientError, match="unknown verdict"):
        judge.judge(_claim("X."), [Chunk(1, "t", "text")])


class _FakeModel:
    def __init__(self, verdict: Verdict) -> None:
        self._verdict = verdict

    def judge(self, claim, chunks):  # type: ignore[no-untyped-def]
        return ModelVerdict(verdict=self._verdict, reason="fake " + claim.text)


def test_judge_records_uses_model_for_leftover_claims() -> None:
    record = InputRecord(
        id="c1",
        answer="The report was thorough.",
        retrieved=(Chunk(1, "t", "some context"),),
    )
    results = judge_records([record], model=_FakeModel(Verdict.UNSUPPORTED), logger=_noop_logger())
    claim = results[0].claims[0]
    assert claim.verdict is Verdict.UNSUPPORTED
    assert claim.method == "model"
    assert claim.evidence == ("fake The report was thorough.",)


def test_judge_records_without_model_marks_claims_unscored() -> None:
    record = InputRecord(
        id="c1",
        answer="The report was thorough.",
        retrieved=(Chunk(1, "t", "some context"),),
    )
    results = judge_records(
        [record],
        model=None,
        logger=_noop_logger(),
        model_unavailable_reason="JUDGE_API_KEY is not set",
    )
    claim = results[0].claims[0]
    assert claim.verdict is None
    assert claim.unscored_reason == "JUDGE_API_KEY is not set"


def test_judge_records_marks_transport_failures_unscored() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "nope"}})

    judge = _judge(handler, max_retries=0)
    record = InputRecord(
        id="c1",
        answer="The report was thorough.",
        retrieved=(Chunk(1, "t", "some context"),),
    )
    results = judge_records([record], model=judge, logger=_noop_logger())
    claim = results[0].claims[0]
    assert claim.verdict is None
    assert "attempts" in (claim.unscored_reason or "")


def test_judge_caps_chunks_shown_to_the_model() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content.decode())
        return _json_response('{"verdict": "supported", "reason": "r"}')

    judge = _judge(handler)
    chunks = [Chunk(i, "t" + str(i), "body " + str(i)) for i in range(10)]
    judge.judge(_claim("X."), chunks)
    assert "[7]" not in seen[0]  # only the first six chunks are shown
    assert "[6]" in seen[0]


def _noop_logger():
    class _Noop:
        def log(self, event: str, **fields):  # type: ignore[no-untyped-def]
            return None

    return _Noop()
