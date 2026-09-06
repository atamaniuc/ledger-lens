# 0017 — Tasks

Lane owner: **unassigned**. Debt: D-63 (new). P0 gates the lane; P1 follows.
A batch is one commit; every commit's message carries the D-XX or spec id.
Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** `scripts/verify-tasks.ts`: parse every `specs/*/tasks.md`,
      extract the check named on each checked line, re-run or look up its
      latest pass; fail with file:line on an unverifiable or failing box
      (AC-01)
- [ ] **T2** Wire T1 into `task check` (alongside `verify-docs.ts`); unit
      tests covering a valid checked box, a box naming no check, and a box
      whose named check currently fails (AC-01)
- [ ] **T3** `scripts/verify-clean-exit.ts` (or extend `verify-docs.ts`):
      grep the diff/tree for stray `console.log`/`debugger` outside
      `*.test.*`/`tests/`, and `TODO`/`FIXME` without a `D-XX` id; wire into
      `task check` (AC-02)
- [ ] **T4** Cold-Start Test protocol: either a `task cold-start-test`
      command or a documented checklist in `docs/HARNESS.md` (proof-marker
      linked) answering the five questions from a fresh read of
      `AGENTS.md`/`specs/` alone (AC-03)

## P1

- [ ] **T5** T1's parser handles the debt-register format too
      (`DEBT.md`'s closure criterion column), so one checker covers both
      files instead of two similar ones drifting apart
- [ ] **T6** T3's grep exceptions (chaos-flag-gated logging) documented
      inline so a future contributor doesn't file it as a false positive
- [ ] **T7** Retire this spec's own P0 tasks from manual review once T1/T2
      are green — dogfood the gate on itself
