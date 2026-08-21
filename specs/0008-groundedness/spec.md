# 0008 — Groundedness

**Status:** partly shipped (4 of 7 tasks) · **Lane:** W3-G · **Debt closed:** D-27, D-03

## Why

- No metric exists for a claim made without a citation — the observed “no invoices are currently overdue” answer verified cleanly (D-27).
- README claims LLM-as-judge as a gate and denies it in the same breath (D-03).

## User stories

**US-01** — As an analyst, I want claim-level groundedness, so every claim in an answer is checked against the retrieved chunks.
**US-02** — As a maintainer, I want the judge as a second CI signal, so an uncited claim cannot verify cleanly.
**US-03** — As a reader, I want README's judge claim resolved, so the doc either describes a real gate or says nothing.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN an answer with claims WHEN the judge runs THEN each claim is decomposed and checked against the retrieved chunks; ungrounded claims are flagged (test: `py/judge` pytest cases, D-27)
**AC-02** — GIVEN the judge output WHEN CI runs THEN it lands in `evals/thresholds.json` and a breach fails the build — the gate is real, not denied (D-03)
**AC-03** — GIVEN an answer with no citations WHEN it is judged THEN it cannot score as verified (eval case derived from the “no invoices overdue” dialogue, D-27)
**AC-04** — GIVEN README's LLM-as-judge lines WHEN groundedness ships THEN each line carries a `<!-- proof: ... -->` marker resolving to the judge, or is removed (verify-docs, D-03)

## Invariants

- The judge is a second signal; the deterministic citation check stays the first.
- A claim without a citation is ungrounded, not unverified-but-fine.
- Judge output is versioned with the eval thresholds.

## Out of scope

- Replacing the deterministic citation check.
- Judging live production traffic (out of scope, same as spec 0007).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W3-G).
