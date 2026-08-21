# 0001 — Tasks

Lane owner: **W1 (sequential)**. Debt: D-36, D-37, D-38, D-29, D-21, D-22. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [x] **T1** Replace Bun with Node 22 + pnpm: package.json, `pnpm-lock.yaml`, remove `bun.lock` and `@types/bun` (D-38)
- [x] **T2** Migrate the 18 `bun:test` test files to Vitest; add `vitest.config.ts` (D-38)
- [x] **T3** Taskfile v2 ≤120 lines: `up dev check verify evals index reset clean`, `default: [task --list]`, no hand-written `help`, no 1:1 aliases (D-36)
- [x] **T4** `task up` — one command from a clean clone; `task env` overwrites only with `--force` (D-37)
- [x] **T5** `deno-check` mandatory inside `check`; availability check in `task up` (D-29)
- [x] **T6** zod env schema + single `src/platform/config.ts`; fail at start (D-21)
- [x] **T7** CI skeleton: jobs `check`, `e2e`, `evals`, `python`, `gitleaks`, `knip` — stubs where the lane is not landed (D-22)

## P1

- [x] **T8** gitleaks active in CI with baseline; knip wired and green after D-41 (spec 0006) (D-22)
- [x] **T9** `task verify` — migrations from empty + e2e + evals in one command

## P2

- [x] **T10** CI badge wired to a real remote so CI status comes from the badge, not prose (supports D-04)

