# Definition of Ready — LedgerLens

One Definition of Ready for the whole project, mirroring `specs/DoD.md`:
referenced, never copied. `DoD` gates a lane at the end; `DoR` gates it at
the start — a `spec.md` moves from `proposed` to `in-progress`, and an agent
opens its `tasks.md` and starts on P0, only when all of the following hold:

1. **Every acceptance criterion already names an executable check** — a test
   name, an eval case id, or an SQL query — before any code is written. The
   same bar `specs/DoD.md` #1 holds the finished work to; a criterion invented
   after the code exists is a criterion that fits the code, not one that
   gated it.
2. **User stories are Given/When/Then-shaped** and traceable to a `D-XX` in
   `DEBT.md`, or state plainly that the capability is new and why — not a
   restatement of the spec's own title.
3. **Invariants and Out of scope are both written**, even short. A spec with
   no stated boundary is a spec that grows mid-lane.
4. **WIP=1 holds** (`AGENTS.md` §Spec and delegation rules): no other spec's
   `tasks.md` has an unchecked P0 box under the same agent/session — or this
   spec is explicitly the one replacing a track marked `blocked` in
   `specs/TRACKS.md`.
5. **`tasks.md` exists** with P0/P1/P2 and a lane owner — or `unassigned`
   for a proposal spec that isn't starting yet (see specs 0016 and 0017 for
   that shape: drafted, nothing built, owner TBD).
6. **No unresolved dependency is silent.** A criterion that needs another
   spec's undelivered work says so in Out of scope, and the lane doesn't
   start on that criterion until the dependency lands or the spec is
   re-scoped.

A spec that fails Ready stays `proposed`: write the missing piece, don't
start code around the gap. Ready and Done bracket a lane — check Ready once,
at the start; check `specs/DoD.md` once, at hand-off — and neither is ever
copied into a `spec.md` rather than referenced.
