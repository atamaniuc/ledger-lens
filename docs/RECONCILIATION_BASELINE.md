# Reconciliation drift — before and after idempotency

The fixed artifact required by [`.claude/PRD.md`](../.claude/PRD.md)'s
Data Quality & Reconciliation US-04: the "before" number is captured once,
during Stage 2, and preserved here. It is never reproduced live — by
Stage 3 idempotency is a shipped P0 guarantee, so there is no
non-idempotent pipeline left to measure, and there is deliberately no
runtime toggle or rollback that would recreate one.

Regenerate the "after" side any time with:

```bash
bun run dev
bun run scripts/capture-reconciliation-baseline.ts
```

## The numbers

Captured 2026-08-17, mock provider seed 42, 200 invoices, chaos flag
`duplicates` on (7 duplicate records injected, ~3.4% repeat rate).

| Source | Total (cents) | Drift vs. provider | Drift % |
|---|---|---|---|
| Provider's independent `/summary` | 52,417,661 | — (source of truth) | — |
| **Before idempotency** — naive consumer, no dedup | 53,806,676 | **+1,389,015** | **+2.650%** |
| **After idempotency** — shipped pipeline | 52,417,661 | **0** | **0.000%** |

## What "before" means here, precisely

It is not a measurement of a broken build. Idempotency was present from
the first migration in this project — `unique (org_id, source,
external_id, event_version)` plus `ON CONFLICT DO NOTHING` — so a
non-idempotent version never ran, and `CLAUDE.md` forbids weakening a
shipped failure-mode guarantee to stage a demo.

What is measured instead is the drift that guarantee *prevents*: the total
a consumer would report if it read the provider's stream and summed it
without deduplicating. That is a real, specific number, not a
hypothetical — the duplicate records genuinely exist in the stream, and
their amounts genuinely sum to 1,389,015 cents of overstatement.

The comparison is against the provider's own `/api/mock-provider/summary`
endpoint, which always computes from the deduplicated dataset regardless
of the `duplicates` flag on `/invoices`. That independence is the whole
point: reconciling derived data against itself proves nothing, because
duplicated rows are perfectly internally consistent with themselves.

## The bug this artifact uncovered

The first attempt at this measurement returned an "after" drift of
**4.37%**, not zero — with the correct record count. The cause was in the
mock provider, not the pipeline: chaos flags were checked with
short-circuit `&&` *before* their random draw, so switching a flag off
skipped the draw and shifted the seeded PRNG stream for every subsequent
record. The same `external_id` came back with a different amount depending
on which flags happened to be set.

That made reconciliation drift impossible to drive to zero no matter how
correct ingestion was, because `/summary` (duplicates forced off) and
`/invoices` (duplicates on) were describing two different datasets. It
also silently falsified the Mock Provider PRD's "deterministic under a
fixed seed" claim.

Fixed in `lib/mock-provider/data.ts` by always consuming the draw and
letting the flag gate only whether its result is applied. Pinned by
`lib/mock-provider/data.test.ts`, which asserts that every flag
combination agrees on amounts for a given seed — while still asserting
that each failure mode is actually injected, so determinism isn't bought
by neutering the chaos.

Worth stating plainly: this defect was in Stage 1 code that had already
passed its own Definition of Done. It was invisible until something
downstream depended on cross-flag consistency, which is exactly the kind
of thing a reconciliation check exists to catch.
