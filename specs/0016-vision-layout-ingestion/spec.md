# 0016 — Vision & Layout-Aware Document Ingestion

**Status:** draft (0 of 8 tasks) · **Lane:** unassigned · **Debt closed:** D-62 (new)

## Why

- Some source documents (scanned invoices, dashboard screenshots, PDFs whose
  tables don't survive flat-text extraction) can't be chunked into text the
  way `search_documents` chunks today — OCR over a misaligned grid loses the
  relationship between a line item and its total (D-62).
- The agent's citation contract is closed: `verifyCitations` (`citations.ts`)
  only accepts `[chunk:<id>]` and `[invoice:<external_id>]`, sourced from a
  tool result in the current turn (`loop.ts`, D-25). A page produced by a
  vision/layout pipeline has no equivalent id today, so an answer built from
  one is currently either impossible to cite (and should abstain) or would be
  reported as verified on a citation format the checker doesn't actually
  recognize — the exact "looks cited, isn't checked" failure D-25 exists to
  prevent (see `loop.ts:599-604`).
- Today there is no vision-embedding/layout-parsing pipeline, no image or
  table-artifact table, and no tool that returns page/bounding-box
  provenance — this spec is greenfield, not hardening.

## User stories

**US-01** — As an analyst uploading a scanned invoice or a table screenshot, I
want line items extracted with page and bounding-box provenance, so a figure
can be traced to the exact visual region it came from.
**US-02** — As a copilot user, I want an answer built from a visual table to
carry a citation the loop verifies the same mechanical way it verifies
`[chunk:id]` today, so a visual answer is trustworthy on the same terms as a
text one — never on a claim in the prompt alone.
**US-03** — As a maintainer, I want an invented visual citation (an
artifact/page/bbox nothing in this turn actually retrieved) rejected by the
same checker that rejects a fabricated chunk id today, so the citation
contract doesn't get a second, weaker path.
**US-04** — As an analyst, when a chart or table region is blurry, cropped at
the embedding boundary, or has no explicit numeric label, I want the agent to
abstain rather than read a number off it, so a low-confidence extraction never
quietly becomes a stated figure.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a scanned or screenshot document run through the new
ingestion path WHEN it lands THEN each extracted line item is stored with
`artifact_id`, `page_number`, `bounding_box` (x1,y1,x2,y2) and a
`confidence` score, RLS-scoped and carrying `run_id` like every other row
(SQL: new migration; test: `tests/vision-ingestion-rls.spec.ts`, D-62)
**AC-02** — GIVEN a `search_visual_documents` (or equivalent) tool result WHEN
the model cites `[visual:<artifact_id>#pX(x1,y1,x2,y2)]` THEN `verifyCitations`
accepts it only if that exact artifact/page/bbox was retrieved this turn — one
checker, one code path, not a parallel one (unit: `citations.test.ts` new
cases, D-62)
**AC-03** — GIVEN a visual line item with `confidence` below the configured
threshold WHEN the agent is asked for that figure THEN the turn ends with
`ABSTENTION_ANSWER`, the same mechanism `EMPTY_STEPS_BEFORE_ABSTAINING`
already uses for empty retrieval — never a model-composed guess (unit:
`loop.test.ts` new case)
**AC-04** — GIVEN an eval case built from a real low-confidence
chart/table region WHEN `task evals` runs THEN a guessed answer scores below
the groundedness threshold and the abstained answer scores at/above it
(`evals/` new case + `evals/thresholds.json`, per CLAUDE.md "new agent
behaviour ships with an eval dataset case and a CI threshold")
**AC-05** — GIVEN the visual artifact tables WHEN migrations run from empty
THEN they apply cleanly and RLS is proven by a non-owner `org_id` getting
empty results, not an error (`task verify` pattern, D-30)

## Invariants

- Visual citations are verified by the same `verifyCitations` code path as
  text citations — never a second, weaker check.
- No visual citation syntax reaches an answer unless a tool this turn
  actually returned matching provenance — same rule already enforced for
  `chunk`/`invoice` ids.
- RLS and `org_id` scoping apply identically to visual artifacts as to every
  other table (non-negotiable invariant, `CLAUDE.md`).
- Below-threshold confidence abstains; it never becomes a hedge in the answer
  text ("approximately", "it looks like") — abstention is a return value, not
  a tone.

## Out of scope

- Choosing the vision-embedding/OCR provider — separate ADR once this spec's
  interface (artifact/page/bbox/confidence) is agreed.
- Any change to the existing text-chunk pipeline (`search_documents`,
  `citations.ts`'s existing chunk/invoice cases stay as-is).
- Backfilling already-ingested documents through the new path.
- The multi-modal prompt language itself — once the tool and the checker
  exist, `prompt.ts` gets a small, tested addition describing the new
  citation form; it does not get written first.

## Tasks

See `tasks.md`. No lane owner assigned yet — this is a proposal spec, not a
started lane; see `handoff.md` for what the next session that picks this up
needs to decide first.
