# Handoff — 0016 Vision & Layout-Aware Document Ingestion

## Context

This lane started from a pasted "system protocol" draft (not part of the
codebase) that asked the agent to cite visual evidence as
`[Source: Image_Hash_PageX_BB(x1,y1,x2,y2)]`. The repo has no vision/layout
pipeline, no image artifact table, and no tool that could supply those
fields — `citations.ts` only knows `[chunk:id]`/`[invoice:external_id]`. The
user confirmed the underlying feature (scanned/screenshot document ingestion)
is a real, intended capability, so this is a proposal spec translating that
intent into the project's existing lane contract, not an implemented lane.

**Nothing has been built.** `spec.md` and `tasks.md` are a draft only —
acceptance criteria are written, no code exists yet.

## What to load

- This file, then `spec.md` and `tasks.md` in this directory.
- `src/features/agent/citations.ts`, `citations.test.ts` — the checker T5
  extends; understand `verifyCitations`'s shape before adding a case to it.
- `src/features/agent/loop.ts:259-341` (`RetrievedEvidence`/`collectEvidence`)
  and the abstention path (`EMPTY_STEPS_BEFORE_ABSTAINING`,
  `ABSTENTION_ANSWER`) — T6 hooks into the same mechanism, not a new one.
- `specs/0004-ingestion-hardening/spec.md` — the existing ingestion pipeline's
  conventions (chaos flags, budget from env, quarantine pattern) T3 should
  follow rather than reinvent.
- `specs/0008-groundedness/spec.md` — how the judge/eval gate is wired; T7
  plugs into the same `evals/thresholds.json`.

## What NOT to load

- The original pasted "protocol" text — it isn't in the repo and isn't a
  source of truth; `spec.md` already extracted the one legitimate idea
  (visual provenance in citations) and dropped the rest (self-policed turn
  budgets, checkpoint tokens, security-alert banners) as redundant with or
  weaker than what `loop.ts`/`injection.ts` already enforce in code.

## State

- Spec + tasks drafted, 0/8 (P0) tasks done.
- No ADR yet on the vision/OCR provider (T1) — this blocks T2 onward.
- No lane owner assigned.

## Decisions

- Visual citations reuse `verifyCitations` — no second checker (see spec
  Invariants). This was the one hard requirement carried over from the
  pasted draft: a citation syntax the code doesn't check is worse than none.
- Below-threshold confidence abstains via the existing `ABSTENTION_ANSWER`
  path rather than a model-composed hedge — matches how empty-retrieval
  abstention already works (US-06 in `loop.ts`'s comments).

## First step

Pick T1 (provider ADR) — everything else in P0 depends on the extraction
output shape it decides. Until T1 lands, this track should stay listed as
**paused (no provider decision)** in `specs/TRACKS.md`, not active.
