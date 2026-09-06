# 0017 — Gated Task State & Session-Exit Cleanliness

**Status:** draft (0 of 7 tasks) · **Lane:** unassigned · **Debt closed:** D-63 (new)

## Why

- A `[x]` in a lane's `tasks.md` is written by the same agent that just wrote
  the code — nothing re-runs the test/eval/SQL the line names before the box
  flips. `DEBT.md` already refuses this for debt items ("ticked only when its
  closure criterion is machine-verifiable"); `tasks.md` has no equivalent
  gate, so the two files enforce different rigor for the same kind of claim
  (D-63).
- `specs/DoD.md` checks build, tests, RLS, secrets and proof markers, but
  nothing checks session-exit hygiene at the text level: a stray
  `console.log`/`debugger`, or a `TODO` with no `D-XX` id, can survive a
  hand-off with `task check` green the whole way (D-63).
- There's no runnable Cold-Start Test: the claim that a fresh session can
  answer "what is this, how do I run it, how do I verify it, what's the
  progress" from `AGENTS.md` + `specs/` alone is never itself checked — it's
  trusted the same way the things above were.

## User stories

**US-01** — As a reviewer, I want a checked `tasks.md` box to be refused
unless the check it names actually passed, so a checked box is proof, not a
claim.
**US-02** — As a maintainer, I want `task check` to flag stray debug
statements and untracked `TODO`s left in a diff, so hand-off stays clean by
default instead of by memory.
**US-03** — As an agent starting a session, I want a runnable Cold-Start
Test, so I can confirm `AGENTS.md`/`specs/` alone are enough before assuming
they are.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a `tasks.md` line checked `[x]` WHEN `task check` runs
THEN a validator parses the check the line names (a test file/name, an eval
case id, or an SQL query) and fails the gate if that check cannot be found or
does not currently pass (script + unit test, D-63)
**AC-02** — GIVEN a diff WHEN `task check` runs THEN it fails on a
`console.log`/`debugger` statement outside `*.test.*`/`tests/`, and on a
`TODO`/`FIXME` comment carrying no `D-XX` id (grep-based check + test, D-63)
**AC-03** — GIVEN a fresh clone with only `AGENTS.md` and `specs/` read
THEN a documented protocol (a command or a checklist in `docs/HARNESS.md`)
answers the five Cold-Start questions — what this is, how it's built, how to
run it, how to verify it, current progress — each pointing at a concrete file
(D-63)

## Invariants

- A checked task box always names an executable check; a box with nothing to
  verify cannot be ticked — the same rule `DEBT.md` already applies to debt
  items, generalized to `tasks.md`.
- The cleanliness gate never flags debug logging already gated by
  `APP_ENV=dev|test` (the chaos-flag invariant in `AGENTS.md`) — only ad-hoc
  statements outside that mechanism.
- WIP=1 (`AGENTS.md` §Spec and delegation rules) and this spec are
  complementary, not redundant: WIP=1 is a process rule for the agent; AC-01
  is the machine gate that catches it if the rule is skipped anyway.

## Out of scope

- Rewriting `tasks.md` into JSON — the validator parses the existing
  dash-and-checkbox markdown; a format change is a separate decision if the
  parser turns out to need one.
- A general lint/static-analysis replacement — this spec is narrowly the two
  gates in AC-01/AC-02 plus the Cold-Start protocol in AC-03.
- Retroactively re-verifying already-closed lanes' historical `tasks.md`
  files — the gate applies going forward.

## Tasks

See `tasks.md`. No lane owner assigned yet — proposal spec, not a started
lane; see `handoff.md`.
