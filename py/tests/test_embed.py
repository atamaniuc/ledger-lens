"""Edge embedder tests: batching, concurrency, retry, validation.

All HTTP is faked with httpx.MockTransport — no live stack involved.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from ledgerlens_indexer.embed import (
    EMBED_BATCH_LIMIT,
    EMBEDDING_DIMENSIONS,
    EdgeEmbedder,
    EmbeddingError,
    LocalEmbedder,
    _validate_response,
)

URL = "https://example.supabase.co"
ANON = "anon-key"
SECRET = "embed-secret"

try:
    import sentence_transformers  # noqa: F401

    HAS_LOCAL_EXTRA = True
except ImportError:
    HAS_LOCAL_EXTRA = False


def _embedder(handler, **kwargs) -> EdgeEmbedder:
    # Tiny, deterministic backoff so retry tests stay fast: rng()=0.5 gives a
    # jitter factor of exactly 1.0 (the TS sleepImpl/random test hooks).
    kwargs.setdefault("backoff_base", 0.001)
    kwargs.setdefault("rng", lambda: 0.5)
    return EdgeEmbedder(
        URL,
        ANON,
        SECRET,
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def _response(texts) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "embeddings": [[0.1] * EMBEDDING_DIMENSIONS for _ in texts],
            "model": "gte-small",
            "dimensions": 384,
        },
    )


async def test_embed_many_splits_into_batches_of_8_and_preserves_order() -> None:
    texts = [f"text {i}" for i in range(17)]
    seen: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body["texts"])
        return _response(body["texts"])

    vectors = await _embedder(handler).embed_many(texts)
    assert len(vectors) == 17
    assert seen == [
        texts[0:EMBED_BATCH_LIMIT],
        texts[EMBED_BATCH_LIMIT:16],
        texts[16:17],
    ]
    assert all(len(v) == EMBEDDING_DIMENSIONS for v in vectors)


async def test_concurrency_is_bounded() -> None:
    texts = [f"t{i}" for i in range(32)]
    active = 0
    max_active = 0
    lock = asyncio.Lock()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, max_active
        async with lock:
            active += 1
            max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        async with lock:
            active -= 1
        body = json.loads(request.content)
        return _response(body["texts"])

    vectors = await _embedder(handler, concurrency=2).embed_many(texts)
    assert max_active == 2
    assert len(vectors) == 32


async def test_retries_503_then_succeeds() -> None:
    # D-47: 503 = the isolate was killed by the CPU budget; the next request
    # gets a fresh isolate, so a retry fixes it.
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="")
        body = json.loads(request.content)
        return _response(body["texts"])

    vectors = await _embedder(handler).embed_many(["hello"])
    assert calls["n"] == 2
    assert len(vectors) == 1


async def test_4xx_is_not_retried() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad batch")

    emb = _embedder(handler)
    with pytest.raises(EmbeddingError) as exc_info:
        await emb.embed_many(["hello"])
    assert exc_info.value.status == 400
    assert exc_info.value.retryable is False
    assert calls["n"] == 1


async def test_exhausts_attempts_then_raises_on_persistent_5xx() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    emb = _embedder(handler)
    with pytest.raises(EmbeddingError) as exc_info:
        await emb.embed_many(["hello"])
    assert exc_info.value.status == 500
    assert exc_info.value.retryable is True
    assert calls["n"] == 4  # MAX_ATTEMPTS, mirroring src/features/rag/embed.ts (D-47)


async def test_transport_failure_retries_then_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    emb = _embedder(handler)
    with pytest.raises(EmbeddingError):
        await emb.embed_many(["hello"])


async def test_timeout_retries_then_raises() -> None:
    # MockTransport does not enforce timeouts, so a read timeout is raised by
    # the transport itself, like a real network timeout would surface as.
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    emb = _embedder(handler)
    with pytest.raises(EmbeddingError):
        await emb.embed_many(["hello"])


async def test_request_headers_and_url() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        body = json.loads(request.content)
        return _response(body["texts"])

    emb = _embedder(handler, correlation_id="corr-123")
    await emb.embed_many(["hello"])
    assert captured["url"] == f"{URL}/functions/v1/embed"
    assert captured["headers"]["authorization"] == f"Bearer {ANON}"
    assert captured["headers"]["x-embed-secret"] == SECRET
    assert captured["headers"]["x-correlation-id"] == "corr-123"


async def test_empty_batch_rejected() -> None:
    emb = _embedder(lambda request: httpx.Response(200, json={"embeddings": []}))
    with pytest.raises(EmbeddingError):
        await emb.embed_many([])


def test_wrong_number_of_vectors_rejected() -> None:
    with pytest.raises(EmbeddingError):
        _validate_response({"embeddings": [[0.1] * EMBEDDING_DIMENSIONS]}, ["a", "b"])


def test_wrong_vector_width_rejected() -> None:
    with pytest.raises(EmbeddingError):
        _validate_response({"embeddings": [[0.1] * 100]}, ["a"])


@pytest.mark.skipif(
    HAS_LOCAL_EXTRA, reason="[local] extra installed; the model would be downloaded"
)
async def test_local_embedder_without_extra_raises_clear_error() -> None:
    with pytest.raises(EmbeddingError, match="uv sync --extra local"):
        await LocalEmbedder().embed_many(["hello"])


async def test_retries_546_then_succeeds() -> None:
    # D-47: 546 WORKER_LIMIT is the same isolate kill with a different name.
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(546, text="worker limit")
        body = json.loads(request.content)
        return _response(body["texts"])

    vectors = await _embedder(handler).embed_many(["hello"])
    assert calls["n"] == 2
    assert len(vectors) == 1


async def test_503_empty_body_message_carries_status_and_hint() -> None:
    # D-47: the failing TS indexer saw "embed function returned 503:" with an
    # empty body and nothing else — the body is carried here, and the status
    # plus a hint survive even when the body is empty.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="")

    emb = _embedder(handler, max_attempts=1)
    with pytest.raises(EmbeddingError) as exc_info:
        await emb.embed_many(["hello"])
    assert exc_info.value.status == 503
    assert "503" in str(exc_info.value)
    assert "D-47" in str(exc_info.value)


async def test_exhausted_retries_carry_the_response_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="early termination has been triggered: isolate abc123")

    emb = _embedder(handler, max_attempts=3)
    with pytest.raises(EmbeddingError) as exc_info:
        await emb.embed_many(["hello"])
    message = str(exc_info.value)
    assert "early termination has been triggered: isolate abc123" in message
    assert "503" in message


async def test_transport_failure_is_retried_with_backoff_then_raises() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("boom", request=request)

    emb = _embedder(handler)
    with pytest.raises(EmbeddingError):
        await emb.embed_many(["hello"])
    assert calls["n"] == 4


def test_batch_size_is_configurable_but_capped_at_8() -> None:
    with pytest.raises(ValueError):
        _embedder(lambda request: _response([]), batch_size=0)
    with pytest.raises(ValueError):
        _embedder(lambda request: _response([]), batch_size=9)  # D-47: never above 8
    with pytest.raises(ValueError):
        _embedder(lambda request: _response([]), max_attempts=0)


async def test_embed_many_respects_a_smaller_batch_size() -> None:
    texts = [f"t{i}" for i in range(13)]
    seen: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body["texts"])
        return _response(body["texts"])

    vectors = await _embedder(handler, batch_size=5).embed_many(texts)
    assert len(vectors) == 13
    assert seen == [texts[0:5], texts[5:10], texts[10:13]]
    assert all(len(batch) <= 5 for batch in seen)


def test_backoff_delay_mirrors_the_ts_policy() -> None:
    # Mirrors backoffMs in src/features/rag/embed.ts: capped exponential with
    # jitter in [0.8, 1.2] of the base; rng()=0.5 gives exactly the base.
    emb = EdgeEmbedder(URL, ANON, SECRET, backoff_base=0.3, backoff_max=4.0, rng=lambda: 0.5)
    assert emb._backoff_delay(1) == 0.3
    assert emb._backoff_delay(2) == 0.6
    assert emb._backoff_delay(3) == 1.2
    assert emb._backoff_delay(5) == 4.0  # capped at backoff_max
    lo = EdgeEmbedder(URL, ANON, SECRET, backoff_base=0.3, backoff_max=4.0, rng=lambda: 0.0)
    hi = EdgeEmbedder(URL, ANON, SECRET, backoff_base=0.3, backoff_max=4.0, rng=lambda: 1.0)
    assert lo._backoff_delay(2) == pytest.approx(0.48)  # 0.8 factor
    assert hi._backoff_delay(2) == pytest.approx(0.72)  # 1.2 factor


async def test_546_splits_batch_in_half_down_to_single_texts() -> None:
    # D-47: out of attempts, a 546 (isolate killed for CPU) is answered by
    # halving the batch recursively — a 1-text request fits the budget, so the
    # work finishes and order is preserved. Mirrors embedTexts in
    # src/features/rag/embed.ts.
    texts = [f"text {i}" for i in range(8)]
    seen: list[list[str]] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        batch = body["texts"]
        seen.append(batch)
        calls["n"] += 1
        if len(batch) > 1:
            return httpx.Response(546, text="worker limit")
        # Single texts succeed; the vector encodes the text so order is provable.
        return httpx.Response(
            200,
            json={
                "embeddings": [
                    [float(int(t.split()[1]))] + [0.0] * (EMBEDDING_DIMENSIONS - 1) for t in batch
                ],
                "model": "gte-small",
                "dimensions": 384,
            },
        )

    vectors = await _embedder(handler, max_attempts=1).embed_many(texts)
    # 8 -> 4+4 -> 2x(2+2) -> 8 singles
    assert sorted((len(b) for b in seen), reverse=True) == [8, 4, 4, 2, 2, 2, 2] + [1] * 8
    assert calls["n"] == 15
    assert [v[0] for v in vectors] == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]  # order preserved


async def test_546_persists_even_for_single_texts_then_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(546, text="worker limit")

    emb = _embedder(handler, max_attempts=1)
    with pytest.raises(EmbeddingError) as exc_info:
        await emb.embed_many(["hello"])
    assert exc_info.value.status == 546
    assert exc_info.value.retryable is True
