# 0005 — Python Services

**Status:** partly shipped (5 of 7 tasks) · **Lane:** W2-C · **Debt closed:** D-42, D-43

## Why

- The repo has 0 lines of Python while the JD names Python as a second language (D-42).
- Indexing embeds 8 texts at a time through the edge; a bulk path with `COPY` is missing (D-43).

## User stories

**US-01** — As a maintainer, I want a Python base under uv with ruff and pytest, so the second language is real and tested, not a name-drop.
**US-02** — As an operator, I want a bulk indexer that batches embeddings and COPYs into `chunks`, so indexing stops being an 8-at-a-time bottleneck.
**US-03** — As CI, I want a python job, so `py/` cannot rot silently.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN `py/` with pyproject.toml WHEN `uv run pytest` runs THEN all tests green; `ruff` and `mypy` clean (CI job `python`, D-42 partial)
**AC-02** — GIVEN a corpus to index WHEN the bulk indexer runs THEN chunks are written idempotently by `content_hash` and a re-run inserts 0 rows (test: `py/tests/test_bulk_indexer.py`, D-43)
**AC-03** — GIVEN the bulk indexer's write path WHEN it writes to `chunks` THEN it uses `service_role` server-side only, keyed by content hash — never reachable from client code (contract in `py/README.md`; test asserts hash-keyed upsert, D-43)
**AC-04** — GIVEN 10 000 documents WHEN the bulk indexer runs THEN wall time beats the 8-at-a-time edge path; the bench is recorded in the task output (D-43)
**AC-05** — GIVEN the repo WHEN CI runs THEN the python job is green and gated like the other jobs (D-42 partial)

## Invariants

- `py/` is the only Python home in the repo.
- Writes to `chunks` happen server-side under `service_role`, idempotent by `content_hash`.
- The bulk indexer produces exactly the same chunks as the TS indexer (parity test).

## Out of scope

- The judge service (spec 0008) and Modal transcription (spec 0009) — same `py/` tree, their own specs.
- Rewriting the RAG search or agent loop in Python (explicitly not done).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W2-C).
