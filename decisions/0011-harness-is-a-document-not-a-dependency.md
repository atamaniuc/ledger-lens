# 0011: The development harness is a document, not a dependency

**Status:** Accepted

## Context

The refactor removed `scripts/harness/` — six scripts and 500+ lines of
README that described a process `CLAUDE.md` no longer had — and replaced it
with files: `AGENTS.md`, `specs/`, `decisions/`, `DEBT.md`, a
proof-marker gate, and a Taskfile. The result is a harness that any model
(Claude Code, Codex, Cursor, a human) can follow, because it is only Markdown
and commands.

The question was whether to extract this into a separate public repository
and connect it, so changes to the harness could be shared and versioned.

## Decision

Keep the harness in this repository, and write it down in
`docs/HARNESS.md` as an extractable pattern rather than a package.

The harness is **not** a runtime dependency; it is a set of conventions that
reference this project's own files and invariants. Extracting it would create
either a template that carries LedgerLens-specific rules (wrong for another
project) or an abstraction that strips them (wrong for this one), plus a
versioning/submodule relationship that can break this repo when the shared
thing changes — the exact coupling the project's rules avoid elsewhere.

The trigger for revisiting is concrete: a second project that needs the same
process. At that point the extraction point is `docs/HARNESS.md`, and the
decision would be a new ADR, not a silent edit.

## Consequences

- Zero coupling risk today: a harness change is reviewed and tested by this
  repository's own `task check`.
- The cost is one document to maintain (`docs/HARNESS.md`) when the process
  changes.
- Cross-project reuse is delayed until there is a second project — accepted,
  because premature extraction is the more expensive of the two risks.

## Alternatives considered

- **Separate public repo + git submodule:** solves future reuse, adds
  submodule churn and a second thing to keep in sync for a single project.
- **npm package:** the harness is not code and has no runtime behavior;
  a package manager is the wrong delivery for Markdown conventions.
- **Leaving it undocumented:** rejected — the harness exists to be followed,
  and a process only in files nobody can read is a process that drifts.
