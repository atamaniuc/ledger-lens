"""Backend parity: index-time (local) and query-time (edge) embeddings must
live in the same vector space.

The edge backend is the query-time path, so a local backend that drifts would
quietly degrade recall. For a fixed sample of texts, cosine similarity
between the two backends must be >= 0.999.

Requires the `[local]` extra (uv sync --extra local) AND a reachable embed
edge function (SUPABASE_URL etc. set). The test skips when either is missing.
"""

from __future__ import annotations

import math
import os

import pytest

from ledgerlens_indexer.embed import EdgeEmbedder, EmbeddingError, LocalEmbedder

try:
    import sentence_transformers  # noqa: F401

    HAS_LOCAL_EXTRA = True
except ImportError:
    HAS_LOCAL_EXTRA = False

SAMPLE = [
    "Invoice INV-2043 for customer Northwind Traders. Amount 1,200.00 USD. "
    "Status open. Issued on 2026-03-01.",
    "Unpaid invoices accrue interest at 1.5 percent per month after the net 30 window closes.",
    "The dispute note says the delivery was signed for by a.brown@example.com on March 14.",
    "Reference numbers look like INV-1.2 and must not be split by the chunker.",
    "Month-end memo: three customers exceeded their credit limit, and two "
    "invoices were escalated to collections.",
]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b)


@pytest.mark.skipif(not HAS_LOCAL_EXTRA, reason="[local] extra not installed")
async def test_local_backend_matches_edge_backend() -> None:
    local = LocalEmbedder()
    try:
        await local.embed_many(["warmup"])
    except Exception as exc:  # model download, HF unreachable, etc.
        pytest.skip(f"local model unavailable in this environment: {exc}")

    base_url = os.environ.get("SUPABASE_URL")
    anon_key = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    secret = os.environ.get("EMBED_SHARED_SECRET")
    if not (base_url and anon_key and secret):
        pytest.skip("edge backend env (SUPABASE_URL / ANON_KEY / EMBED_SHARED_SECRET) not set")
    edge = EdgeEmbedder(base_url, anon_key, secret)
    try:
        edge_vectors = await edge.embed_many(SAMPLE)
    except EmbeddingError as exc:
        pytest.skip(f"edge function unreachable in this environment: {exc}")

    local_vectors = await local.embed_many(SAMPLE)
    for i, (lv, ev) in enumerate(zip(local_vectors, edge_vectors, strict=True)):
        similarity = _cosine(lv, ev)
        assert similarity >= 0.999, f"sample {i}: cosine {similarity:.6f} < 0.999"
