# 0005 — Tasks

Lane owner: **W2-C**. Debt: D-42, D-43. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** `py/` scaffold: uv, pyproject.toml, ruff, mypy, pytest + pytest-asyncio (D-42)
- [ ] **T2** Bulk indexer: batched embeddings + COPY upsert into `chunks`, idempotent by hash (D-43)
- [ ] **T3** Parity test: bulk indexer output == TS indexer output for the same corpus (D-43)
- [ ] **T4** CI job `python`: pytest + ruff + mypy (D-42)

## P1

- [ ] **T5** Query-time embedding cache on the chat path (server-side), keyed by text hash (D-43)
- [ ] **T6** Benchmark script comparing bulk vs edge-batch indexing

## P2

- [ ] **T7** Re-embed migration helper for an embedding-model swap (chunks.embedding_model is per-row)

