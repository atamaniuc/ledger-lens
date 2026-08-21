# 0001 — Runtime and Command Surface

**Status:** proposed · **Lane:** W1 (sequential) · **Debt closed:** D-36, D-37, D-38, D-29, D-21, D-22

## Why

- Four runtimes and a 435-line Taskfile make the repo's own command surface a source of drift (D-36/D-38).
- A five-step cold start means every lane and every reviewer pays setup tax (D-37).
- Env is read pointwise, `deno-check` silently skips, and CI scans no secrets (D-21/D-29/D-22).

## User stories

**US-01** — As a lane agent, I want the whole stack up from a clean clone with one command, so setup never consumes a lane.
**US-02** — As CI, I want check/e2e/evals/python/gitleaks/knip jobs scaffolded, so each lane turns its stub on as it lands.
**US-03** — As a developer, I want env validated once at start, so a typo fails fast with the variable named.
**US-04** — As a maintainer, I want a Taskfile that never lies about its own surface, so the printed help is the real surface.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a clean clone on a machine with Node 22 + pnpm WHEN I run `task up` THEN install → stack → env → seed → URL completes with no manual step (e2e: `tests/up-from-clean.spec.ts`, D-37)
**AC-02** — GIVEN an existing `.env.local` WHEN I run `task env` without `--force` THEN it does not crash and does not overwrite; with `--force` it does (test: `tests/taskfile.test.ts`, D-37)
**AC-03** — GIVEN the Taskfile WHEN I run `task` THEN `task --list` shows exactly up/dev/check/verify/evals/index/reset/clean and no `design` or `help` target (grep: `task --list` diff, D-36)
**AC-04** — GIVEN the repo WHEN `task check` runs THEN deno-check always runs — never silently skipped; `task up` verifies deno availability (D-29)
**AC-05** — GIVEN an env with a missing or invalid variable WHEN the app boots THEN it fails with a zod error naming the variable, from one `src/platform/config.ts` (unit: `config.test.ts`, D-21)
**AC-06** — GIVEN a commit containing a secret-shaped string WHEN CI runs THEN gitleaks fails the job (CI job `gitleaks`, D-22)
**AC-07** — GIVEN the repo WHEN CI runs THEN the six jobs check/e2e/evals/python/gitleaks/knip exist, each green or an explicit stub to be turned on by its lane (D-22, prepares D-23)
**AC-08** — GIVEN `bun` mentioned anywhere (package.json, lockfile, Taskfile, docs) WHEN CI runs THEN grep fails — no Bun remains; build runs on Node 22 + pnpm (D-38)

## Invariants

- One runtime set: Node 22 + pnpm + Deno (edge functions only). No Bun, no extra runtimes.
- One `config.ts`; env validated once, at start.
- `task evals` runs the identical command CI runs — no local/CI divergence.
- `task check` is the lane hand-off gate.

## Out of scope

- Writing lane features (their own specs 0002–0012).
- Deploying or infra (spec 0010).
- README/DOCS prose (docs lane, spec 0012).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W1 (sequential)).
