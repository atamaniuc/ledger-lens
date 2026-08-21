# Reconciliation — the drift pair, and why accounted value is the honest comparison

The fixed artifact required by the PRD's Data Quality & Reconciliation
US-04. The "before" number was captured once, during Stage 2, and is
preserved here — never reproduced live, because idempotency is now a shipped
P0 guarantee and there is deliberately no toggle that would recreate a
non-idempotent pipeline.

## The numbers

Captured 2026-08-17 against the mock provider: seed 42, 200 invoices, chaos
flag `duplicates` on (7 duplicate records injected, ~3.4% repeat rate).
Reproduced read-only at any time with
`pnpm exec tsx scripts/capture-reconciliation-baseline.ts [baseUrl]`.

| Source | Total (cents) | Drift vs. provider |
|---|---|---|
| Provider's independent `/summary` | 52,417,661 | — (source of truth) |
| **Before idempotency** — naive sum, no dedup | 53,806,676 | **+1,389,015 (+2.650%)** |
| **After idempotency** — shipped pipeline | 52,417,661 | **0 (0.000%)** |

"Before" is not a broken build: idempotency — `raw_events`' unique
`(org_id, source, external_id, event_version)` plus `ON CONFLICT DO NOTHING`
— has shipped since the first migration. It is the drift that guarantee
prevents: the duplicate records genuinely exist in the stream and genuinely
sum to 1,389,015 cents. `/summary` always computes from the deduplicated
dataset, so the comparison is against an independent source, never derived
data agreeing with itself.

## Accounted value

The live check (`run_data_quality_checks`, run on every run, recorded in
`data_quality_results`) compares the provider total against **accounted
value**: `sum(invoices.amount_cents)` plus the amounts still recoverable
from quarantined records' original payloads.

Comparing against `sum(invoices)` alone under-reports by the quarantined
value — in the captured run, 4,475,029 cents (−8.54%) on a pipeline behaving
exactly as designed, because quarantining the records the provider corrupts
(~8% null fields, ~3% future dates) is correct behaviour, not loss. Accounted value lands on zero and
states the property that matters: **no value disappears silently.** A
quarantine row whose payload can no longer be parsed is counted as
`unaccounted_rows` and fails the check regardless of the arithmetic.
The reasoning and the rejected alternatives are in ADR 0005.

## What this artifact caught

The first "after" measurement returned **+4.37%** with the correct record
count. The mock provider's chaos flags short-circuited with `&&` *before*
their random draw, so switching a flag off skipped the draw and shifted the
seeded PRNG for every record after it — `/summary` (duplicates forced off)
and `/invoices` (duplicates on) were describing two different datasets.
Fixed in `src/features/provider/data.ts` by always consuming the draw and
letting the flag gate only whether its result is applied; pinned by
`src/features/provider/data.test.ts`, which asserts every flag combination
agrees on amounts for a given seed while still injecting each failure mode.

<!-- proof: scripts/capture-reconciliation-baseline.ts -->
<!-- proof: migration:20260818103000 --> <!-- proof: src/features/provider/data.ts --> <!-- proof: src/features/provider/data.test.ts -->
<!-- proof: src/features/quality/run-checks.ts:runChecks -->
