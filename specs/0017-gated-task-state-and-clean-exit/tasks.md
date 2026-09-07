# 0017 — Tasks

Lane owner: **unassigned**. Debt: D-63 (new). P0 gates the lane; P1 follows.
A batch is one commit; every commit's message carries the D-XX or spec id.
Ticked only against the DoD (`specs/DoD.md`).

## P0

- [x] **T1** `scripts/verify-tasks.ts` + `src/platform/tasks-proof.ts`: parse
      every `specs/*/tasks.md`, require a `<!-- proof: ... -->` marker on
      each checked line, resolve it through `checkTarget` (the same checker
      `docs-proof.ts` uses); fail with file:line on a box naming no check or
      whose marker doesn't resolve. Scoped to live tracks only
      (`liveTrackSpecDirs` from `specs/TRACKS.md`) — already-shipped lanes'
      historical `tasks.md` files are grandfathered per Out of scope (AC-01)
      <!-- proof: src/platform/tasks-proof.test.ts -->
- [x] **T2** Wired into `task harness` (which `task check` calls), and still
      runnable alone through `task docs-check`,
      alongside `verify-docs.ts`; unit tests cover a valid checked box, a box
      naming no check, and a box whose named check doesn't resolve (AC-01)
      <!-- proof: Taskfile.yml:verify-tasks.ts -->
      <!-- proof: src/platform/tasks-proof.test.ts#flags a checked task that names no check at all -->
- [x] **T3** Clean-exit check, closed by `harnessimo clean-exit` rather than a
      local script (spec 0018): the markers this repository cares about are
      configuration, `scripts/` is exempt because a CLI's output is its
      product, and the check reads what the session changed rather than the
      whole tree. Wired into CI (AC-02)
      <!-- proof: harnessimo.config.json:cleanExit -->
      <!-- proof: .github/workflows/ci.yml#harnessimo clean-exit -->
- [x] **T4** Cold-Start Test, closed by `harnessimo cold-start` rather than a
      checklist: it clones HEAD into an empty directory and runs the documented
      commands there, so the answer is a command's exit code rather than a
      reader's judgement. Wired into CI (AC-03)
      <!-- proof: harnessimo.config.json:coldStart -->
      <!-- proof: .github/workflows/ci.yml#harnessimo cold-start -->

## P1

- [ ] **T5** T1's parser handles the debt-register format too
      (`DEBT.md`'s closure criterion column), so one checker covers both
      files instead of two similar ones drifting apart
- [ ] **T6** T3's grep exceptions (chaos-flag-gated logging) documented
      inline so a future contributor doesn't file it as a false positive
- [ ] **T7** Retire this spec's own P0 tasks from manual review once T1/T2
      are green — dogfood the gate on itself
