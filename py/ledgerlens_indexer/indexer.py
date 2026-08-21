"""Idempotent bulk corpus indexer — a port of lib/rag/index-corpus.ts.

Reads both halves of the corpus — `documents` text and `invoices` rows
rendered to prose — and keeps `chunks` in step with them.

The bar is Stage 2's, applied to a derived table: running it twice writes
nothing the second time. What makes that true is the content hash. A chunk
whose hash is unchanged is not re-embedded, and embedding is the only
expensive step here.

The write path is server-side only (service_role in production, direct SQL
here): there is no end user behind `task index`, so nothing in the browser
can reach it. Rows are written with COPY through a temp staging table plus
an ON CONFLICT upsert keyed on (document_id, chunk_no) / (invoice_id,
chunk_no), never per-row inserts.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row

from ledgerlens_indexer.chunk import Chunk, chunk_text, hash_text, render_invoice
from ledgerlens_indexer.embed import Embedder
from ledgerlens_indexer.logs import JsonLogger

DEFAULT_WRITE_BATCH_SIZE = 200


@dataclass
class IndexStats:
    documents: int = 0
    invoices: int = 0
    chunks_inserted: int = 0
    chunks_updated: int = 0
    chunks_deleted: int = 0
    chunks_unchanged: int = 0
    embeddings_computed: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "documents": self.documents,
            "invoices": self.invoices,
            "chunks_inserted": self.chunks_inserted,
            "chunks_updated": self.chunks_updated,
            "chunks_deleted": self.chunks_deleted,
            "chunks_unchanged": self.chunks_unchanged,
            "embeddings_computed": self.embeddings_computed,
        }


@dataclass(frozen=True)
class _StoredChunk:
    id: int
    chunk_no: int
    content_hash: str


@dataclass
class _PendingChunk:
    org_id: Any
    document_id: Any
    invoice_id: Any
    chunk_no: int
    content: str
    content_hash: str
    existing: _StoredChunk | None


# Staging table is TEMP and ON COMMIT DROP: it lives only on this connection
# and only inside the indexer's transaction, so a shared database never sees
# it. COPY goes in as text; the cast happens in the upsert below.
_STAGE_DDL = """
create temp table if not exists _chunk_stage (
  org_id uuid not null,
  document_id uuid,
  invoice_id uuid,
  chunk_no int not null,
  content text not null,
  content_hash text not null,
  embedding text not null,
  embedding_model text not null,
  updated_at timestamptz not null
) on commit drop
"""

_COPY_SQL = """
copy _chunk_stage (org_id, document_id, invoice_id, chunk_no, content, content_hash,
                   embedding, embedding_model, updated_at)
from stdin
"""

# Two conflict targets, so two upserts, exactly like the TS indexer:
# PostgREST names one target per call, and a document chunk can never
# collide with an invoice chunk. The WHERE clause is what lets ON CONFLICT
# infer the corresponding partial unique index.
_DOC_UPSERT = """
insert into chunks (org_id, document_id, chunk_no, content, content_hash,
                    embedding, embedding_model, updated_at)
select org_id, document_id, chunk_no, content, content_hash,
       embedding::extensions.vector, embedding_model, updated_at
from _chunk_stage
where document_id is not null
on conflict (document_id, chunk_no) do update set
  content = excluded.content,
  content_hash = excluded.content_hash,
  embedding = excluded.embedding,
  embedding_model = excluded.embedding_model,
  updated_at = excluded.updated_at
"""

_INV_UPSERT = """
insert into chunks (org_id, invoice_id, chunk_no, content, content_hash,
                    embedding, embedding_model, updated_at)
select org_id, invoice_id, chunk_no, content, content_hash,
       embedding::extensions.vector, embedding_model, updated_at
from _chunk_stage
where invoice_id is not null
on conflict (invoice_id, chunk_no) do update set
  content = excluded.content,
  content_hash = excluded.content_hash,
  embedding = excluded.embedding,
  embedding_model = excluded.embedding_model,
  updated_at = excluded.updated_at
"""


def _vector_text(vector: list[float]) -> str:
    # repr gives shortest round-trip floats; the vector input function parses
    # it back to the same doubles.
    return "[" + ",".join(repr(v) for v in vector) + "]"


def _batched(items: list[_PendingChunk], size: int) -> Iterator[list[_PendingChunk]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _write_batch(
    conn: Connection[Any], rows: list[dict[str, Any]], model: str, updated_at: datetime
) -> None:
    """COPYs one batch through the temp staging table and upserts it."""
    with conn.cursor() as cur:
        cur.execute(_STAGE_DDL)
        cur.execute("truncate _chunk_stage")
        with cur.copy(_COPY_SQL) as copy:
            for row in rows:
                copy.write_row(
                    (
                        row["org_id"],
                        row["document_id"],
                        row["invoice_id"],
                        row["chunk_no"],
                        row["content"],
                        row["content_hash"],
                        _vector_text(row["embedding"]),
                        model,
                        updated_at,
                    ),
                )
        cur.execute(_DOC_UPSERT)
        cur.execute(_INV_UPSERT)


async def index_corpus(
    conn: Connection[Any],
    embedder: Embedder | None,
    *,
    org_id: str | None = None,
    dry_run: bool = False,
    correlation_id: str = "",
    log: JsonLogger | None = None,
    write_batch_size: int = DEFAULT_WRITE_BATCH_SIZE,
) -> IndexStats:
    """Reconciles `chunks` with `documents` + `invoices`, embedding only what changed.

    Dry-run mode reads and chunks the corpus, computes the exact plan, logs it
    and writes nothing — it never calls the embedder. A real run embeds
    pending chunks (batched, concurrently in the edge backend) and COPY-upserts
    them. The connection is never committed here: the caller owns the
    transaction, which is how tests keep every write rolled back.
    """
    stats = IndexStats()
    logger = log or JsonLogger(correlation_id)
    if write_batch_size < 1:
        raise ValueError("write_batch_size must be at least 1")

    logger.log(
        "indexer_start", backend=getattr(embedder, "model", None), dry_run=dry_run, org_id=org_id
    )

    with conn.cursor(row_factory=dict_row) as cur:
        if org_id is not None:
            cur.execute(
                "select id, org_id, body from documents where org_id = %s order by id", (org_id,)
            )
        else:
            cur.execute("select id, org_id, body from documents order by id")
        documents = cur.fetchall()

        if org_id is not None:
            cur.execute(
                "select id, org_id, external_id, customer, amount_cents, "
                "currency, status, issued_at, paid_at from invoices "
                "where org_id = %s order by id",
                (org_id,),
            )
        else:
            cur.execute(
                "select id, org_id, external_id, customer, amount_cents, "
                "currency, status, issued_at, paid_at from invoices order by id",
            )
        invoices = cur.fetchall()

        stats.documents = len(documents)
        stats.invoices = len(invoices)
        logger.log("corpus_read", documents=len(documents), invoices=len(invoices), org_id=org_id)

        # One read of stored chunks for the whole corpus, then a per-parent map:
        # same decisions as the TS indexer, without its N+1 queries.
        document_ids = [row["id"] for row in documents]
        invoice_ids = [row["id"] for row in invoices]
        stored: list[dict[str, Any]] = []
        if document_ids or invoice_ids:
            cur.execute(
                "select id, document_id, invoice_id, chunk_no, content_hash from chunks "
                "where document_id = any(%s) or invoice_id = any(%s)",
                (document_ids, invoice_ids),
            )
            stored = cur.fetchall()

    stored_by_parent: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in stored:
        if row["document_id"] is not None:
            key = ("document", str(row["document_id"]))
        else:
            key = ("invoice", str(row["invoice_id"]))
        stored_by_parent.setdefault(key, []).append(row)

    pending: list[_PendingChunk] = []
    stale_ids: list[int] = []

    def reconcile_document(
        parent_key: tuple[str, str], org_id_value: Any, doc_id: Any, desired: list[Chunk]
    ) -> None:
        by_number = {
            row["chunk_no"]: _StoredChunk(row["id"], row["chunk_no"], row["content_hash"])
            for row in stored_by_parent.get(parent_key, [])
        }
        for chunk in desired:
            existing = by_number.get(chunk.chunk_no)
            if existing is not None and existing.content_hash == chunk.content_hash:
                stats.chunks_unchanged += 1
                continue
            pending.append(
                _PendingChunk(
                    org_id=org_id_value,
                    document_id=doc_id,
                    invoice_id=None,
                    chunk_no=chunk.chunk_no,
                    content=chunk.content,
                    content_hash=chunk.content_hash,
                    existing=existing,
                ),
            )
        for chunk_no, row in by_number.items():
            if chunk_no >= len(desired):
                stale_ids.append(row.id)

    def reconcile_invoice(
        parent_key: tuple[str, str], org_id_value: Any, inv_id: Any, desired: list[Chunk]
    ) -> None:
        by_number = {
            row["chunk_no"]: _StoredChunk(row["id"], row["chunk_no"], row["content_hash"])
            for row in stored_by_parent.get(parent_key, [])
        }
        for chunk in desired:
            existing = by_number.get(chunk.chunk_no)
            if existing is not None and existing.content_hash == chunk.content_hash:
                stats.chunks_unchanged += 1
                continue
            pending.append(
                _PendingChunk(
                    org_id=org_id_value,
                    document_id=None,
                    invoice_id=inv_id,
                    chunk_no=chunk.chunk_no,
                    content=chunk.content,
                    content_hash=chunk.content_hash,
                    existing=existing,
                ),
            )
        for chunk_no, row in by_number.items():
            if chunk_no >= len(desired):
                stale_ids.append(row.id)

    for document in documents:
        desired = await chunk_text(document["body"])
        reconcile_document(
            ("document", str(document["id"])), document["org_id"], document["id"], desired
        )

    for invoice in invoices:
        content = render_invoice(invoice)
        # One invoice is one chunk: the rendering is a sentence long, and
        # splitting it would separate the amount from the identifier.
        desired = [Chunk(0, content, hash_text(content))]
        reconcile_invoice(
            ("invoice", str(invoice["id"])), invoice["org_id"], invoice["id"], desired
        )

    if dry_run:
        stats.chunks_inserted = sum(1 for c in pending if c.existing is None)
        stats.chunks_updated = sum(1 for c in pending if c.existing is not None)
        stats.chunks_deleted = len(stale_ids)
        logger.log(
            "dry_run_plan",
            dry_run=True,
            **stats.as_dict(),
            sample=[c.content[:120] for c in pending[:5]],
        )
    else:
        if stale_ids:
            with conn.cursor() as cur:
                cur.execute("delete from chunks where id = any(%s)", (stale_ids,))
            stats.chunks_deleted = len(stale_ids)

        if pending:
            if embedder is None:
                raise ValueError("an embedder is required unless --dry-run")
            for batch in _batched(pending, write_batch_size):
                embeddings = await embedder.embed_many([c.content for c in batch])
                if len(embeddings) != len(batch):
                    raise ValueError("embedder returned the wrong number of vectors")
                stats.embeddings_computed += len(embeddings)
                updated_at = datetime.now(UTC)
                rows = [
                    {
                        "org_id": c.org_id,
                        "document_id": c.document_id,
                        "invoice_id": c.invoice_id,
                        "chunk_no": c.chunk_no,
                        "content": c.content,
                        "content_hash": c.content_hash,
                        "embedding": embeddings[i],
                    }
                    for i, c in enumerate(batch)
                ]
                _write_batch(conn, rows, embedder.model, updated_at)
                for c in batch:
                    if c.existing:
                        stats.chunks_updated += 1
                    else:
                        stats.chunks_inserted += 1

    logger.log("index_corpus_done", dry_run=dry_run, **stats.as_dict())
    return stats
