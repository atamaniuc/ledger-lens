# LedgerLens — Agent Rules

The only rules file for agents. `CLAUDE.md` is a symlink to this file. Human
documentation lives in `README.md` and `docs/`; per-lane contracts live in
`specs/`; the debt register is `DEBT.md`. Nothing else needs reading to start
a lane.

## Non-negotiable invariants
- RLS on every table — enforced by a SQL test, not by prose.
- `correlation_id` on every log line; `run_id` on every data row.
- No `service_role` key in client code (`app/**`, `components/**`).
- Chaos flags are never softened to make a run pass, and are OFF outside
  `APP_ENV=dev|test`.
- No cross-`org_id` query without an explicit filter.
- No hardcoded hex or px in a component; design tokens live in one file.
- New agent behaviour ships with an eval dataset case and a CI threshold.

## Command surface
- `task up` — one command from a clean clone (install → stack → env → seed → URL).
- `task check` — typecheck, lint, unit, deno-check; must be green before hand-off.
- `task verify` — integration: migrations from empty, e2e, evals.
- `task evals` — the identical command CI runs.
- `task index` — rebuild the chunk index (idempotent, content-hashed).

## Spec and delegation rules
- One spec = one lane = one deliverable. Start from `specs/NNNN-<slug>/spec.md`.
- Acceptance criteria are executable: a test name, an eval case id, or an SQL
  query. A criterion that cannot run does not exist.
- The Definition of Done is `specs/DoD.md` — referenced, never copied.
- A debt item is ticked in `DEBT.md` only when its closure criterion is
  machine-verifiable.
- Commit messages carry the `D-XX` id or the spec id they close; branch
  `lane/<letter>-<slug>`, conventional commits, no `--no-verify`, no
  force-push to `main`.
- Lanes never write prose into README/docs; docs are written once by the docs
  lane and verified by `<!-- proof: ... -->` markers in `task check`.
- Machine feedback is the first reviewer: typecheck, tests, the page rendering.

## Definition of Done
See `specs/DoD.md` — it is the single DoD for every lane.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
