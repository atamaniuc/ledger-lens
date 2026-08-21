"""Bulk indexer tests (spec 0005 AC-02/AC-03, D-43).

Every test that writes runs inside a transaction that is always rolled back
"""

from __future__ import annotations

import hashlib
import uuid

from ledgerlens_indexer.chunk import chunk_text, hash_text, render_invoice
from ledgerlens_indexer.embed import EMBEDDING_MODEL
from ledgerlens_indexer.indexer import index_corpus

SENTENCE = "Sentence number {n} says something about invoices and terms."


def _paragraph(count: int) -> str:
    return " ".join(SENTENCE.format(n=i) for i in range(count))


class StubEmbedder:
    """Deterministic 384-dim vectors; records every embed call."""

    model = EMBEDDING_MODEL

    def __init__(self) -> None:
        self.calls = 0
        self.texts: list[str] = []

    async def embed_many(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        self.texts.extend(texts)
        return [
            [float(hashlib.sha256(t.encode("utf-8")).digest()[i % 32]) / 255.0 for i in range(384)]
            for t in texts
        ]


def _make_org(conn) -> uuid.UUID:
    org_id = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute("insert into orgs (id, name) values (%s, %s)", (org_id, "py-test-org"))
    return org_id


def _make_document(conn, org_id: uuid.UUID, body: str, title: str = "Py test doc") -> uuid.UUID:
    doc_id = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute(
            "insert into documents (id, org_id, title, kind, body, content_hash) "
            "values (%s, %s, %s, %s, %s, %s)",
            (doc_id, org_id, title, "memo", body, hash_text(body)),
        )
    return doc_id


def _make_invoice(
    conn,
    org_id: uuid.UUID,
    *,
    external_id: str = "INV-PY-1",
    customer: str = "PyCorp",
    amount_cents: int = 120000,
    currency: str = "usd",
    status: str = "open",
    issued_at: str = "2026-03-01",
    paid_at: str | None = None,
) -> uuid.UUID:
    run_id = uuid.uuid4()
    inv_id = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute(
            "insert into pipeline_runs (id, org_id, source, kind, status) "
            "values (%s, %s, 'py-test', 'full', 'succeeded')",
            (run_id, org_id),
        )
        row = cur.execute(
            "insert into raw_events (org_id, source, external_id, payload, payload_hash, run_id) "
            "values (%s, 'py-test', %s, '{}', %s, %s) returning id",
            (org_id, external_id, hash_text(external_id), run_id),
        ).fetchone()
        raw_id = row["id"]
        cur.execute(
            "insert into invoices (id, org_id, external_id, customer, "
            "amount_cents, currency, status, "
            "issued_at, paid_at, raw_event_id, run_id, pipeline_version) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'py-test')",
            (
                inv_id,
                org_id,
                external_id,
                customer,
                amount_cents,
                currency,
                status,
                issued_at,
                paid_at,
                raw_id,
                run_id,
            ),
        )
    return inv_id


def _update_document(conn, doc_id: uuid.UUID, body: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "update documents set body = %s, content_hash = %s where id = %s",
            (body, hash_text(body), doc_id),
        )


def _chunk_rows(conn, org_id: uuid.UUID) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "select id, document_id, invoice_id, chunk_no, content, content_hash, "
            "embedding_model, updated_at "
            "from chunks where org_id = %s order by chunk_no",
            (org_id,),
        )
        return cur.fetchall()


def _count_chunks(conn, org_id: uuid.UUID) -> int:
    return len(_chunk_rows(conn, org_id))


async def test_dry_run_plans_and_writes_nothing(tx) -> None:
    org = _make_org(tx)
    _make_document(tx, org, _paragraph(30))
    _make_invoice(tx, org)
    stub = StubEmbedder()
    stats = await index_corpus(tx, stub, org_id=str(org), dry_run=True)
    assert stats.documents == 1
    assert stats.invoices == 1
    assert stats.chunks_inserted >= 2
    assert stats.chunks_unchanged == 0
    assert stats.embeddings_computed == 0
    assert stub.calls == 0  # dry-run never calls the embedder
    assert _count_chunks(tx, org) == 0  # nothing written


async def test_second_run_writes_nothing(tx) -> None:
    org = _make_org(tx)
    _make_document(tx, org, _paragraph(30))
    _make_invoice(tx, org)
    stub = StubEmbedder()

    first = await index_corpus(tx, stub, org_id=str(org))
    assert first.chunks_inserted >= 2
    assert first.embeddings_computed == first.chunks_inserted
    first_rows = _chunk_rows(tx, org)
    first_updated = {r["id"]: r["updated_at"] for r in first_rows}

    # Idempotent by content hash: a second run in a row writes nothing.
    second = await index_corpus(tx, stub, org_id=str(org))
    assert second.chunks_inserted == 0
    assert second.chunks_updated == 0
    assert second.chunks_deleted == 0
    assert second.chunks_unchanged == len(first_rows)
    assert second.embeddings_computed == 0
    assert stub.calls == 1  # no re-embedding
    assert _count_chunks(tx, org) == len(first_rows)

    # Stored hashes are the chunker's own, so the skip decision is honest.
    for row in _chunk_rows(tx, org):
        assert row["content_hash"] == hash_text(row["content"])
        assert row["updated_at"] == first_updated[row["id"]]


async def test_edited_body_updates_chunks_and_shrinks_clean_up(tx) -> None:
    org = _make_org(tx)
    doc = _make_document(tx, org, _paragraph(30))
    stub = StubEmbedder()
    first = await index_corpus(tx, stub, org_id=str(org))
    n1 = _count_chunks(tx, org)
    assert first.chunks_inserted == n1

    # Edit: one sentence reworded — only the chunk that contains it changes
    # hash; the other chunks are untouched.
    new_body = _paragraph(30).replace("Sentence number 3 says", "Sentence number THREE says")
    new_chunks = await chunk_text(new_body)
    _update_document(tx, doc, new_body)
    second = await index_corpus(tx, stub, org_id=str(org))
    assert second.chunks_inserted == 0
    assert second.chunks_updated == 1
    assert second.chunks_unchanged == len(new_chunks) - 1
    assert second.chunks_deleted == 0
    assert _count_chunks(tx, org) == len(new_chunks)

    # Shrink: a much shorter body leaves stale tail chunks behind, and the
    # indexer removes them instead of answering from text that is gone.
    short_body = "Short memo now. Only two sentences total."
    short_chunks = await chunk_text(short_body)
    _update_document(tx, doc, short_body)
    third = await index_corpus(tx, stub, org_id=str(org))
    assert third.chunks_updated == len(short_chunks)
    assert third.chunks_deleted == len(new_chunks) - len(short_chunks)
    assert third.chunks_inserted == 0
    assert _count_chunks(tx, org) == len(short_chunks)


async def test_invoice_is_one_hash_keyed_chunk(tx) -> None:
    org = _make_org(tx)
    inv = _make_invoice(
        tx,
        org,
        external_id="INV-PY-9",
        customer="Globex Inc",
        amount_cents=123456789,
        currency="eur",
        status="paid",
        paid_at="2026-03-20",
    )
    stub = StubEmbedder()
    stats = await index_corpus(tx, stub, org_id=str(org))
    assert stats.invoices == 1
    assert stats.chunks_inserted == 1
    rows = _chunk_rows(tx, org)
    assert len(rows) == 1
    row = rows[0]
    assert row["invoice_id"] == inv
    assert row["document_id"] is None
    assert row["chunk_no"] == 0
    expected = render_invoice(
        {
            "external_id": "INV-PY-9",
            "customer": "Globex Inc",
            "amount_cents": 123456789,
            "currency": "eur",
            "status": "paid",
            "issued_at": "2026-03-01",
            "paid_at": "2026-03-20",
        },
    )
    assert row["content"] == expected
    assert row["content_hash"] == hash_text(expected)
    assert row["embedding_model"] == EMBEDDING_MODEL


async def test_org_filter_isolates_tenants(tx) -> None:
    org_a = _make_org(tx)
    org_b = _make_org(tx)
    _make_document(tx, org_a, _paragraph(10))
    _make_document(tx, org_b, _paragraph(10))
    stub = StubEmbedder()
    stats = await index_corpus(tx, stub, org_id=str(org_a))
    assert stats.documents == 1
    assert stats.chunks_inserted == _count_chunks(tx, org_a)
    assert _count_chunks(tx, org_b) == 0
