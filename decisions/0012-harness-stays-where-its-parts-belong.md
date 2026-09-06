# 0012: Harness files stay where their parts belong — no `.harness/` directory

**Status:** Accepted

## Context

The "Learn Harness Engineering" guide
(https://walkinglabs.github.io/learn-harness-engineering/) frames a harness
as five subsystems — instructions, tools, environment, state, feedback — and
its own template library groups sample files under one folder. The question
raised: should this repo's harness-related files (`AGENTS.md`, `specs/`,
`DEBT.md`, `decisions/`, `scripts/verify-docs.ts`, `evals/`) move under a
single `.harness/` directory, split into five subfolders matching that
model, so a newcomer with no technical background can orient faster?

This repository already has direct experience with the opposite move.
D-32/D-33/D-34/D-35 in `DEBT.md` record three harness-adjacent folders
(`scripts/harness/`, a duplicate RU README, `.ua/`/`.task/` state) that
existed at different points and were **deleted**, not consolidated, because
they described a process that had drifted from what `AGENTS.md` actually
said. ADR 0011 separately decided the harness stays in-tree as a document
rather than becoming an extractable package, for the same reason: moving or
abstracting the files costs more than the newcomer-friendliness it buys,
until there's a second project that needs the same shape.

A physical move to `.harness/` would touch every one of the 175+
`<!-- proof: ... -->` markers `scripts/verify-docs.ts` currently resolves,
`specs/TRACKS.md`'s `checkTracks` links, `Taskfile.yml`'s paths, and every
cross-reference in `README.md`/`docs/`. All of that is mechanical, but it is
also exactly the class of change most likely to leave one stale link behind
— which the proof-marker gate exists to catch, at the cost of a lane spent
re-verifying a reorganization instead of shipping a deliverable.

## Decision

Keep every harness file in the location its *kind* already lives in:
- `AGENTS.md` at the root (the one file an agent must read).
- Lane contracts and state in `specs/` (`DoR.md`, `DoD.md`, `NNNN-<slug>/`,
  `TRACKS.md`, `TRACKS-LOG.md`).
- The debt register at the root (`DEBT.md`) — it predates and outlives any
  single lane.
- Irreversible decisions in `decisions/`.
- Checks in `scripts/` and `Taskfile.yml`.

Instead of moving files, `docs/HARNESS.md` gains a five-layer *reading map*
(§"The five layers (a map for newcomers)") that regroups the existing table
by instructions/tools/environment/state/feedback — the pedagogical benefit
the guide's model offers — without relocating anything or touching a single
proof marker.

## Consequences

- Zero migration risk: no proof marker, `checkTracks` link, or Taskfile path
  changes.
- A newcomer gets the five-layer orientation from one added table in
  `docs/HARNESS.md`, not from learning a new directory layout.
- If a second project later needs the harness as a shared, physically
  separate artifact, that is ADR 0011's trigger (a second consumer), and the
  directory question can be revisited then — together, not for
  newcomer-friendliness alone.
