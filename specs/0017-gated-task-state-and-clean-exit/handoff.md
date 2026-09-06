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

**Nothing has been built.** `spec.md`/`tasks.md` are a draft; no script
exists yet.

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

- Spec + tasks drafted, 0/7 tasks done.
- No lane owner assigned.
- Depends on nothing else in flight; T1 and T3 are independent and could be
  split across two sessions if picked up under WIP=1 (`AGENTS.md`).

## Decisions

- The validator parses the existing markdown `tasks.md` format rather than
  moving to JSON — no evidence yet that markdown is the bottleneck.
- Clean-exit grep exempts logging already gated by `APP_ENV=dev|test`
  (the chaos-flag invariant) — it targets ad-hoc debug statements outside
  that mechanism, not the mechanism itself.

## First step

T1 (`scripts/verify-tasks.ts`) — read `verify-docs.ts` first so the new
script matches its shape (one `Problem[]`-returning checker function per
convention, wired into the same CLI) instead of becoming a second, divergent
doc-proof tool.
