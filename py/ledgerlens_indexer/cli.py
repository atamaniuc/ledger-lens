"""Command-line entry point for the bulk corpus indexer.

    ledgerlens-index [--backend edge|local] [--dry-run] [--org-id UUID]

Reads DB_URL from the environment (or the --db-url flag); the edge backend
additionally needs SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
EMBED_SHARED_SECRET. Every log line is JSON with a correlation_id.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from collections.abc import Sequence

import psycopg

from ledgerlens_indexer.embed import (
    DEFAULT_CONCURRENCY,
    DEFAULT_LOCAL_MODEL,
    EMBED_BATCH_LIMIT,
    EdgeEmbedder,
    Embedder,
    EmbeddingError,
    LocalEmbedder,
)
from ledgerlens_indexer.indexer import DEFAULT_WRITE_BATCH_SIZE, index_corpus
from ledgerlens_indexer.logs import JsonLogger

DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def _required_env(name: str, provided: str | None) -> str:
    value = provided or os.environ.get(name)
    if not value:
        raise EmbeddingError(f"{name} is not set")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ledgerlens-index",
        description="Rebuild the chunks index idempotently (spec 0005, D-43).",
    )
    parser.add_argument(
        "--backend",
        choices=("edge", "local"),
        default="edge",
        help="embedding backend: edge function (default) or local sentence-transformers",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="read and chunk the corpus, print the plan, write nothing",
    )
    parser.add_argument(
        "--org-id", default=None, help="limit the run to one tenant; absent means every org"
    )
    parser.add_argument(
        "--correlation-id",
        default=None,
        help="id carried on every log line; defaults to a fresh uuid",
    )
    parser.add_argument(
        "--embed-concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help="max concurrent requests to the edge function",
    )
    parser.add_argument(
        "--embed-batch-size",
        type=int,
        default=EMBED_BATCH_LIMIT,
        help=f"texts per request to the edge function (max {EMBED_BATCH_LIMIT}, D-47)",
    )
    parser.add_argument(
        "--write-batch-size",
        type=int,
        default=DEFAULT_WRITE_BATCH_SIZE,
        help="rows per COPY upsert",
    )
    parser.add_argument("--db-url", default=None, help="defaults to $DB_URL or the local stack URL")
    parser.add_argument(
        "--supabase-url", default=None, help="edge backend: defaults to $SUPABASE_URL"
    )
    parser.add_argument(
        "--anon-key", default=None, help="edge backend: defaults to $NEXT_PUBLIC_SUPABASE_ANON_KEY"
    )
    parser.add_argument(
        "--embed-secret", default=None, help="edge backend: defaults to $EMBED_SHARED_SECRET"
    )
    parser.add_argument(
        "--local-model", default=None, help="local backend: checkpoint id, defaults to gte-small"
    )
    return parser


def build_embedder(args: argparse.Namespace, correlation_id: str) -> Embedder:
    if args.backend == "edge":
        base_url = _required_env("SUPABASE_URL", args.supabase_url)
        anon_key = _required_env("NEXT_PUBLIC_SUPABASE_ANON_KEY", args.anon_key)
        secret = _required_env("EMBED_SHARED_SECRET", args.embed_secret)
        return EdgeEmbedder(
            base_url,
            anon_key,
            secret,
            correlation_id=correlation_id,
            concurrency=args.embed_concurrency,
            batch_size=args.embed_batch_size,
            logger=JsonLogger(correlation_id),
        )
    model = args.local_model or os.environ.get("EMBED_LOCAL_MODEL") or DEFAULT_LOCAL_MODEL
    return LocalEmbedder(model, correlation_id)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    correlation_id = args.correlation_id or str(uuid.uuid4())
    log = JsonLogger(correlation_id)
    db_url = args.db_url or os.environ.get("DB_URL") or DEFAULT_DB_URL
    try:
        embedder = None if args.dry_run else build_embedder(args, correlation_id)
        with psycopg.connect(db_url) as conn:
            asyncio.run(
                index_corpus(
                    conn,
                    embedder,
                    org_id=args.org_id,
                    dry_run=args.dry_run,
                    correlation_id=correlation_id,
                    log=log,
                    write_batch_size=args.write_batch_size,
                ),
            )
        return 0
    except (EmbeddingError, ValueError, psycopg.Error) as exc:
        log.log("indexer_failed", error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
