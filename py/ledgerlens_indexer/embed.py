"""Embedding backends for the bulk indexer.

Two backends, one vector space (parity is asserted by tests/test_embed_parity.py):

- edge (default, no heavy deps): calls the existing `embed` Edge Function
  (supabase/functions/embed) — same headers, same 8-texts-per-request limit,
  but unlike the TS indexer it runs requests concurrently, bounded by a
  semaphore, so a full-corpus rebuild stops being an 8-at-a-time crawl.

  Resilience (D-47): the Edge Runtime kills an isolate that exceeds its
  per-request CPU budget — the gateway then answers 503 with an empty body,
  or 546 WORKER_LIMIT, and the TS client's single retry with no backoff made
  a full `task index` fail intermittently with no diagnosable message. This
  client retries 5xx (503/546 especially) with exponential backoff and
  jitter — the kill is transient, the next request gets a fresh isolate —
  and always carries the response body in the error message.

- local (optional extra `[local]`): sentence-transformers with the same
  gte-small model (384 dims, normalize_embeddings=True). Query time always
  goes through the Edge Function, so a drifting local backend would quietly
  degrade recall — the parity test exists to catch exactly that.
"""

from __future__ import annotations

import asyncio
import importlib
import random
from collections.abc import Callable, Sequence
from typing import Any, Protocol

import httpx

from ledgerlens_indexer.logs import JsonLogger

EMBEDDING_MODEL = "gte-small"
EMBEDDING_DIMENSIONS = 384
# Mirrors MAX_TEXTS in the Edge Function; a larger batch is rejected there.
# Eight because the runtime's per-request CPU budget kills a batch of 16
# mid-flight (HTTP 546, no partial result) — a limit, not a tuning choice.
EMBED_BATCH_LIMIT = 8
DEFAULT_TIMEOUT_MS = 20_000
# Measured against the live stack (D-47): the embed function is CPU-bound at
# ~0.85 s per 8-text batch regardless of concurrency — the Edge Runtime
# serializes isolate work — so concurrency beyond 2 buys nothing while making
# a CPU-budget kill marginally more likely (1/16 raw 503 at c=4 vs 0/40 at
# c=2 in a 40-batch stress). 2 is the evidence-backed default.
DEFAULT_CONCURRENCY = 2
# D-47: the CPU-budget kill answers 503 (empty body) or 546 WORKER_LIMIT.
# Both are transient — a retry runs in a fresh isolate.
CPU_BUDGET_STATUSES = (503, 546)
WORKER_LIMIT_STATUS = 546
# Mirrors src/features/rag/embed.ts (D-47): four attempts, not two — a killed
# isolate needs time to be replaced, and the first retry lands too early to
# find a new one. Backoff is capped exponential with jitter in [0.8, 1.2].
DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_BACKOFF_BASE = 0.3  # seconds, doubled per retry
DEFAULT_BACKOFF_MAX = 4.0  # seconds (cap, like MAX_BACKOFF_MS)

# Local model id: the sentence-transformers checkpoint behind gte-small,
# same 384-dimension mean-pooled space the Edge Function serves.
DEFAULT_LOCAL_MODEL = "thenlper/gte-small"


class EmbeddingError(Exception):
    """A failed embed call, mirroring EmbeddingError in lib/rag/embed.ts.

    retryable is False for a fault a second identical request cannot fix — a
    4xx, or a response whose shape is wrong. Retrying those costs a full
    round trip to arrive at the same failure.
    """

    def __init__(
        self, message: str, status: int | None = None, retryable: bool | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable if retryable is not None else (status is None or status >= 500)


class Embedder(Protocol):
    """Anything that turns texts into one 384-dim vector each, in order."""

    model: str

    async def embed_many(self, texts: Sequence[str]) -> list[list[float]]: ...


class EdgeEmbedder:
    """Calls the `embed` Edge Function concurrently, batch_size texts per request.

    Order is preserved: concurrent requests are gathered and flattened in
    submission order. Concurrency is bounded so a burst of batches does not
    pile up on the gateway.

    The retry policy mirrors src/features/rag/embed.ts (D-47) rather than
    inventing its own:

    - up to MAX_ATTEMPTS attempts (four, not two — a killed isolate needs time
      to be replaced, and the first retry lands too early to find a new one);
    - capped exponential backoff with jitter in [0.8, 1.2] of the base, slept
      before every retry;
    - the response body is always carried into the error message: the 503 that
      killed the TS indexer had an empty body, and the body was the first
      thing a diagnosis needed;
    - a 4xx is our bug, not a blip, and is never retried;
    - out of attempts, an HTTP 546 (WORKER_LIMIT — the runtime killed the
      isolate for CPU) is answered by splitting the batch in half and
      recursing, down to single texts, because a smaller request can still
      fit the budget. Order is preserved.
    """

    def __init__(
        self,
        base_url: str,
        anon_key: str,
        secret: str,
        *,
        correlation_id: str = "",
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        concurrency: int = DEFAULT_CONCURRENCY,
        batch_size: int = EMBED_BATCH_LIMIT,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        backoff_base: float = DEFAULT_BACKOFF_BASE,
        backoff_max: float = DEFAULT_BACKOFF_MAX,
        rng: Callable[[], float] | None = None,
        logger: JsonLogger | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # The function rejects anything over MAX_TEXTS with a 400; raising the
        # batch above 8 is not a tuning choice, it is the bug D-47 documents.
        if batch_size < 1 or batch_size > EMBED_BATCH_LIMIT:
            raise ValueError(f"batch_size must be between 1 and {EMBED_BATCH_LIMIT}")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self.model = EMBEDDING_MODEL
        self._url = f"{base_url.rstrip('/')}/functions/v1/embed"
        self._headers = {
            "content-type": "application/json",
            # The gateway wants a Supabase key before the function is reached
            # at all; the shared secret is what the function itself checks.
            "authorization": f"Bearer {anon_key}",
            "x-embed-secret": secret,
        }
        if correlation_id:
            self._headers["x-correlation-id"] = correlation_id
        self._timeout = httpx.Timeout(timeout_ms / 1000.0)
        self._semaphore = asyncio.Semaphore(concurrency)
        self._batch_size = batch_size
        self._max_attempts = max_attempts
        self._backoff_base = backoff_base
        self._backoff_max = backoff_max
        self._rng = rng
        self._logger = logger
        self._transport = transport

    def _backoff_delay(self, retry_no: int) -> float:
        """Mirror of backoffMs in src/features/rag/embed.ts (D-47): capped
        exponential, jittered in [0.8, 1.2] of the base, in seconds."""
        base: float = min(self._backoff_base * (2 ** (retry_no - 1)), self._backoff_max)
        factor: float = 0.8 + (self._rng() if self._rng is not None else random.random()) * 0.4
        return base * factor

    async def embed_many(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            raise EmbeddingError("embedTexts called with an empty batch")
        batches = [
            list(texts[i : i + self._batch_size]) for i in range(0, len(texts), self._batch_size)
        ]
        results = await asyncio.gather(*(self._embed_batch(b) for b in batches))
        return [vector for batch in results for vector in batch]

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        if len(texts) > self._batch_size:
            raise EmbeddingError(f"batch of {len(texts)} exceeds the limit of {self._batch_size}")
        last_error: EmbeddingError | None = None
        # The semaphore guards only the request loop; the 546 batch-halving
        # recursion below re-enters _embed_batch, so it must not hold a permit
        # while waiting for its own children.
        async with (
            self._semaphore,
            httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client,
        ):
            for attempt in range(1, self._max_attempts + 1):
                if attempt > 1:
                    await asyncio.sleep(self._backoff_delay(attempt - 1))
                try:
                    response = await client.post(
                        self._url, json={"texts": texts}, headers=self._headers
                    )
                except httpx.HTTPError as exc:
                    # Transport failure or timeout — retryable like a 5xx.
                    last_error = EmbeddingError(f"embed request failed: {exc}")
                    continue
                if 400 <= response.status_code < 500:
                    # 4xx is our bug, not a blip: a 401 means the secret is
                    # wrong, a 400 means the batch itself is wrong. No
                    # amount of retrying fixes either.
                    detail = response.text[:200]
                    raise EmbeddingError(
                        f"embed function returned {response.status_code}: {detail}",
                        response.status_code,
                        False,
                    )
                if response.status_code >= 500:
                    detail = response.text[:200]
                    # D-47: 503 (empty body) / 546 mean the isolate was
                    # killed by the CPU budget; the body may be empty, so
                    # the status and a hint are what make this diagnosable.
                    hint = (
                        " (edge-runtime CPU budget killed the isolate — D-47)"
                        if response.status_code in CPU_BUDGET_STATUSES
                        else ""
                    )
                    last_error = EmbeddingError(
                        f"embed function returned {response.status_code}: {detail}{hint}",
                        response.status_code,
                    )
                    continue
                return _validate_response(response.json(), texts)
        # Out of attempts. A resource limit on a batch is the one fault a
        # smaller request can still satisfy, so try that before giving up —
        # mirrors the 546 halving in src/features/rag/embed.ts (D-47).
        if last_error is not None and last_error.status == WORKER_LIMIT_STATUS and len(texts) > 1:
            half = (len(texts) + 1) // 2
            left = await self._embed_batch(texts[:half])
            right = await self._embed_batch(texts[half:])
            return left + right
        raise last_error or EmbeddingError("embed request failed")


def _validate_response(body: Any, texts: list[str]) -> list[list[float]]:
    embeddings = body.get("embeddings") if isinstance(body, dict) else None
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise EmbeddingError(
            "embed function returned the wrong number of vectors",
            None,
            False,
        )
    for vector in embeddings:
        # Caught here rather than at the insert, where the message would be a
        # Postgres type error several layers from the cause.
        if not isinstance(vector, list) or len(vector) != EMBEDDING_DIMENSIONS:
            raise EmbeddingError(
                "embed function returned a vector of the wrong width",
                None,
                False,
            )
    return [[float(x) for x in vector] for vector in embeddings]


class LocalEmbedder:
    """sentence-transformers gte-small, normalize_embeddings=True.

    The heavy import is deferred so the module (and the indexer) import
    cleanly without the `[local]` extra installed. Encoding is CPU-bound and
    blocking, so it runs in a worker thread.
    """

    def __init__(self, model_name: str = DEFAULT_LOCAL_MODEL, correlation_id: str = "") -> None:
        self.model = model_name
        self._correlation_id = correlation_id
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            # importlib keeps the heavy import out of module import time and
            # lets mypy check this file without the optional extra installed.
            try:
                module = importlib.import_module("sentence_transformers")
            except ImportError as exc:
                raise EmbeddingError(
                    "sentence-transformers is not installed; run `uv sync --extra local`",
                ) from exc
            self._model = module.SentenceTransformer(self.model)
        return self._model

    async def embed_many(self, texts: Sequence[str]) -> list[list[float]]:
        model = await asyncio.to_thread(self._load)
        vectors = await asyncio.to_thread(_encode, model, list(texts))
        for vector in vectors:
            if len(vector) != EMBEDDING_DIMENSIONS:
                raise EmbeddingError(
                    f"local model returned {len(vector)} dimensions, "
                    f"expected {EMBEDDING_DIMENSIONS}",
                    None,
                    False,
                )
        return vectors


def _encode(model: Any, texts: list[str]) -> list[list[float]]:
    # mean pooling comes from the checkpoint's configuration; normalization
    # mirrors the Edge Function's `normalize: true`.
    encoded = model.encode(texts, normalize_embeddings=True)
    return [list(map(float, row)) for row in encoded]
