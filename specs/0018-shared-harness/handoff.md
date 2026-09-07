# Handoff — 0018 Shared harness adoption

## Context

The documentation proof gate, the work-track audit and the task gate were written here
(specs 0012, 0015, 0017) and are the better half of this repository's harness. A sibling
repository (`code-knowledge-base`) independently grew the other half: a queue that owns
state transitions, a locked-surface rule, and a cold-start test.

Both halves now live in [`atamaniuc/harness`](https://github.com/atamaniuc/harness), so
this repository can gain locked surfaces and cold start — neither of which it has ever had
— without writing them, and stop being the only place its own proof rules exist.

## What to load

- This file, then `harness.config.json` in the repository root.
- `src/platform/docs-proof.ts`, `src/platform/tasks-proof.ts`, `scripts/verify-docs.ts`,
  `scripts/verify-tasks.ts` — the four files that become a thin wrapper over the package.
- `Taskfile.yml`, specifically the `docs-check` target, and `.github/workflows/ci.yml`.

**What NOT to load:** `src/features/**`, `supabase/**`, `py/**`, `evals/**`. This lane
touches the documentation gate and CI wiring only. This is a large application and reading
it will spend the session's budget without changing anything here.

## State

**Landed:** `harness.config.json` (every check translated, including the three this
repository does not yet run) and `.harness/locked-baseline`.

Two of the configured checks are new capabilities rather than translations, from lectures 12
and 04 of Learn Harness Engineering: `clean-exit` (debris a build compiles happily) and
`instructions` (the router that grew into a manual). Both were run against this repository's
history before being configured, and both needed tuning that is recorded in the config's
own `$comment`: `scripts/` is exempt from the `console.log` marker because those are
command-line tools whose output is the product, and the progress-file rule is off because
"where I stopped" lives in a track's handoff here, not in one file.

**Verified, and worth knowing before touching anything:** the shared implementation
produces byte-identical results to this repository's own gate on the current tree — 183
proof markers across 70 documents, and the task gate scoping to 2 live lanes with 15
closed ones correctly out of scope. The migration is therefore a delegation, not a
behaviour change. If those numbers ever differ, the difference is the bug.

**Not landed:** the dependency and the switch. The package was not installable when this
lane started (the repository is new and carries no tag yet), so `Taskfile.yml` and CI
still call the local implementation.

## Decisions taken

- **Keep the TypeScript wrapper.** `task check` and this repository's own unit tests call
  into `src/platform/docs-proof.ts`; the wrapper stays and delegates, so the rule exists
  once and the entry point does not move. The test for a successful migration is that the
  rule has one implementation, not that the wrapper disappeared.
- **Do not adopt the queue.** This repository runs on lane task lists, which the task gate
  already covers. Two overlapping notions of "the current item" would be worse than one.
- **The cold-start command list is deliberately modest** (`pnpm install --frozen-lockfile`
  then a typecheck). The full `task check` needs Deno, Task and a Playwright browser, and
  a cold-start test that fails because a runner is missing measures the runner rather than
  the repository. Widening it is a decision, not an oversight.

## First step

`pnpm add -D github:atamaniuc/harness#v0.1.0`, then make `src/platform/docs-proof.ts`
re-export the package's rules and keep only what is specific here (the Supabase migration
resolver and this repository's `MUST_CARRY_PROOF` list — both already expressed in
`harness.config.json`). Its unit tests must pass untouched; if one needs changing, the
delegation changed behaviour and that is the thing to look at.
