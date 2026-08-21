"""The model half: an OpenAI-compatible groundedness judge over httpx.

Zero-cost constraints (decisions/0010, spec 0008):
  - the judge runs on a DIFFERENT provider/model than the answerer (config.py
    enforces it);
  - every provider it can use has a free tier — groq, nvidia, or any
    OpenAI-compatible endpoint. anthropic is deliberately unsupported (no
    free tier, no OpenAI-compatible chat endpoint);
  - with no key present the run skips loudly and non-zero (cli.py), never a
    silent pass.

The client is small and dependency-light on purpose: httpx is already a
dependency of the py project, so the judge adds none.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ledgerlens_judge.claims import Claim
from ledgerlens_judge.verifiers import Chunk, Verdict

MAX_CHUNKS_PER_CLAIM = 6
MAX_CHUNK_CHARS = 600

_RETRYABLE_STATUS = (429, 500, 502, 503, 504)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)

_SYSTEM_PROMPT = (
    "You are the groundedness judge for a financial-analyst copilot. Given one "
    "CLAIM and the RETRIEVED CHUNKS the answer was supposed to come from, decide "
    "whether the claim is grounded.\n"
    "- supported: the retrieved chunks state the claim or it follows directly from them.\n"
    "- contradicted: the retrieved chunks state something that conflicts with the claim.\n"
    "- unsupported: the retrieved chunks neither state it nor imply it. A claim the "
    "retrieved context does not support is ungrounded — do not call it supported "
    "because it sounds plausible.\n"
    'Answer with JSON only: {"verdict": "supported" | "unsupported" | "contradicted", '
    '"reason": "one sentence naming the chunk(s) that settle it"}'
)


class ModelClientError(RuntimeError):
    """A model call that could not produce a verdict (transport, HTTP, parse)."""


class ModelClient(Protocol):
    def judge(self, claim: Claim, chunks: Sequence[Chunk]) -> ModelVerdict: ...


@dataclass(frozen=True)
class ModelVerdict:
    verdict: Verdict
    reason: str


class OpenAICompatibleJudge:
    """A chat-completions groundedness judge over any OpenAI-compatible endpoint."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float = 30.0,
        max_retries: int = 2,
        retry_base_s: float = 1.5,
        rng: Callable[[], float] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._model = model
        self._max_retries = max_retries
        self._retry_base_s = retry_base_s
        self._rng = rng if rng is not None else random.random
        self._client = httpx.Client(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=timeout_s,
            transport=transport,
        )

    def judge(self, claim: Claim, chunks: Sequence[Chunk]) -> ModelVerdict:
        payload: dict[str, Any] = {
            "model": self._model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": self._render(claim, chunks)},
            ],
        }
        last_error = "no attempt made"
        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.post("/chat/completions", json=payload)
            except httpx.HTTPError as exc:
                last_error = f"transport error: {exc}"
            else:
                if response.status_code == 200:
                    return self._parse(response.json())
                if response.status_code in _RETRYABLE_STATUS:
                    last_error = f"HTTP {response.status_code}"
                else:
                    raise ModelClientError(
                        f"judge endpoint returned HTTP {response.status_code}: "
                        f"{response.text[:200]}"
                    )
            if attempt < self._max_retries:
                time.sleep(self._retry_base_s * (2**attempt) * (0.5 + self._rng()))
        raise ModelClientError(
            f"judge call failed after {self._max_retries + 1} attempts: {last_error}"
        )

    def _parse(self, data: Any) -> ModelVerdict:
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelClientError(f"unexpected chat completion shape: {exc}") from exc
        verdict, reason = _parse_verdict_json(content)
        return ModelVerdict(verdict=verdict, reason=reason)

    def _render(self, claim: Claim, chunks: Sequence[Chunk]) -> str:
        lines = [f"CLAIM: {claim.text}", "", "RETRIEVED CHUNKS:"]
        for index, chunk in enumerate(chunks[:MAX_CHUNKS_PER_CLAIM], start=1):
            title = chunk.title or "untitled"
            body = " ".join(chunk.text.split())[:MAX_CHUNK_CHARS]
            lines.append(f"[{index}] {title}: {body}")
        lines.append("")
        lines.append("Answer with the JSON verdict object.")
        return "\n".join(lines)


def _parse_verdict_json(content: str) -> tuple[Verdict, str]:
    text = content.strip()
    match = _JSON_OBJECT_RE.search(text)
    if match is None:
        raise ModelClientError("judge response contained no JSON object")
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ModelClientError(f"judge response JSON did not parse: {exc}") from exc
    raw = str(obj.get("verdict", "")).strip().lower()
    try:
        verdict = Verdict(raw)
    except ValueError as exc:
        raise ModelClientError(f"judge returned unknown verdict {raw!r}") from exc
    reason = str(obj.get("reason", "")).strip()[:400]
    return verdict, reason
