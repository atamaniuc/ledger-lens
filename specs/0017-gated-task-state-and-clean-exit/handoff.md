# Handoff — 0017 Gated Task State & Session-Exit Cleanliness

## Context

Came out of a comparison against the "Learn Harness Engineering" guide
(walkinglabs.github.io/learn-harness-engineering). Two of its ideas weren't
covered anywhere in this repo yet: (1) a feature/task list whose checked
state is machine-gated against a real passing check, not self-reported by
the agent that wrote the code (the guide's lecture 08/09); (2) an explicit,
runnable session-exit cleanliness check beyond build+tests (lecture 12).
`DEBT.md` already does something close to (1) in spirit ("ticked only when
machine-verifiable") but nothing enforces it — this spec generalizes and
enforces both.

**T1/T2 shipped** (`src/platform/tasks-proof.ts` + `scripts/verify-tasks.ts`,
wired into `task docs-check`, 16 unit tests, dogfooded on this file's own
tasks.md). T3 (clean-exit grep) and T4 (Cold-Start Test protocol) are still
draft only — no code for either yet.

## What to load

- This file, then `spec.md`/`tasks.md`.
- `scripts/verify-docs.ts` — T1–T3's sibling; look at how it's structured
  (parses markdown, collects `Problem[]`, exits non-zero) before writing a
  second, inconsistent checker. `src/platform/docs-proof.ts` is the logic
  `verify-docs.ts` calls into (`checkTracks`/`checkHandoffRefs` are the
  closest precedent for "parse a markdown convention, fail task check on a
  violation").
- `Taskfile.yml`'s `docs-check`/`check` targets — T2/T3 wire in beside them.
- `specs/DoD.md` — AC-03's Cold-Start Test should sit next to, not duplicate,
  the existing exit checklist there.

## What NOT to load

- The original guide URL isn't part of the repo and isn't authoritative here
  — `spec.md` already extracted the two ideas worth keeping (gated state,
  clean-exit grep) and left out what didn't fit (Graph Engineering, a
  parallel JSON feature-list format) — see that spec's Out of scope.

## State

- 2/7 tasks done (T1, T2). T3, T4 (P0) and T5-T7 (P1) remain.
- No lane owner assigned.
- T3 (clean-exit grep) is independent of T1/T2 and can start cold. T4
  (Cold-Start Test) has no code dependency either — both are candidates for
  the next WIP=1 slot on this track.

## Decisions

- The validator parses the existing markdown `tasks.md` format rather than
  moving to JSON — no evidence yet that markdown is the bottleneck.
- Clean-exit grep exempts logging already gated by `APP_ENV=dev|test`
  (the chaos-flag invariant) — it targets ad-hoc debug statements outside
  that mechanism, not the mechanism itself.

## First step

T3 (`scripts/verify-clean-exit.ts` or an extension of `verify-docs.ts`) —
grep-based, same `Problem[]` shape as `tasks-proof.ts`/`docs-proof.ts`, wire
into `task docs-check` next to `verify-tasks.ts`.

Note from T1/T2: a tasks.md list item commonly wraps across lines (this
repo's own convention) — `tasks-proof.ts`'s `taskBlocks()` groups a `- [x]`
line with its indented continuation before scanning for markers, and
`isSyntaxExample` (exported from `docs-proof.ts`) filters out an
illustrative `<!-- proof: ... -->` written as documentation rather than a
real claim. Both were real bugs caught by dogfooding the gate on this
spec's own tasks.md — worth the same care in T3's grep.
