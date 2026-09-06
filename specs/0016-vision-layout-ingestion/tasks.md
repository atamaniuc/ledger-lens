# 0016 — Tasks

Lane owner: **unassigned**. Debt: D-62 (new). P0 gates the lane; P1/P2 follow.
A batch is one commit; every commit's message carries the D-XX or spec id.
Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** ADR: pick the vision-embedding/OCR provider and the extraction
      output shape (artifact_id, page_number, bounding_box, confidence,
      raw text if any) — decides what T2 stores (D-62)
- [ ] **T2** Migration: visual artifact + line-item tables, RLS policies,
      `run_id`/`org_id` on every row, SQL RLS test (AC-01, AC-05)
- [ ] **T3** Ingestion path: scanned document → provider call → stored line
      items with provenance; chaos/error handling matches the existing
      ingestion pipeline's conventions (spec 0004)
- [ ] **T4** `search_visual_documents` tool (or extend `search_documents`):
      returns artifact_id/page/bbox/confidence per result
- [ ] **T5** `citations.ts`: accept and verify `[visual:...]` against this
      turn's retrieved visual evidence — same function, new case, no parallel
      checker (AC-02)
- [ ] **T6** `loop.ts`: below-threshold confidence routes to
      `ABSTENTION_ANSWER` before the model composes an answer over it (AC-03)

## P1

- [ ] **T7** Eval case from a real low-confidence chart/table; wired into
      `evals/thresholds.json` (AC-04)
- [ ] **T8** `prompt.ts`: small, tested addition describing the `[visual:...]`
      citation form — only after T5/T6 exist, bump `PROMPT_VERSION`

## P2

- [ ] **T9** Admin/debug view for a visual artifact's stored bounding box
      against the source page (operator trust, not user-facing)
- [ ] **T10** Backfill tooling for already-ingested scanned documents
      (explicitly out of scope for this spec's AC — separate decision)
