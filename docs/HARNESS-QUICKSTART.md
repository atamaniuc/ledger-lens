# Harness quickstart — one screen

The first thing to tell any agent (Claude Code / Codex / Cursor / anything):

> Read `AGENTS.md` first. Start from a spec, not from chat. Every acceptance
> criterion must name an executable check. Finish only when `task check` is
> green and `specs/DoD.md` holds. Commit messages carry `D-XX` or the spec id.

## Start a task

1. `specs/NNNN-<slug>/spec.md` exists? No → create it (status `proposed`,
   Given/When/Then criteria, each naming a test / eval case / SQL).
2. Write `tasks.md`: **P0** blocks shipping · **P1** required · **P2** nice.
3. Work. Branch `lane/<letter>-<slug>`, conventional commits, no
   `--no-verify`, no force-push to main.
4. Before hand-off: `task check` green · acceptance checks green ·
   `tasks.md` ticked · debt ids ticked only on machine-verifiable evidence.
5. A human reviews the diff against the spec's criteria.

## The five commands that matter

```bash
task check        # typecheck + lint + unit + deno + doc-proofs — first reviewer
task verify       # check + types-check + e2e + evals — the full gate
task evals        # identical command CI runs
task check-py     # python (indexer + judge) and the Modal app
task check-infra  # the Pulumi program, no credentials
```

## Model-agnostic in three rules

- The process is files, not plugins — any model reads the same Markdown.
- `CLAUDE.md` → `AGENTS.md` symlink, so Claude Code and the human read one
  truth; other tools: tell them to read `AGENTS.md`.
- The proof-marker gate (`task check`) is what stops docs from lying, and it
  runs identically in every tool.

See `docs/HARNESS.md` for the full map and where each idea came from.
