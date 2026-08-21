# LedgerLens — the development harness

The process layer that turns "an AI can edit this repo" into "any AI can keep
editing this repo without breaking the trust story". It is deliberately
**model-agnostic**: nothing here calls a specific tool. Claude Code, Codex,
Cursor, or a human with `vim` all work against the same files.

The harness is a **document**, not a dependency. It lives in this repository
on purpose. Extracting it to a separate package is a decision for when a
second project needs it — see
[decisions/0011-harness-is-a-document-not-a-dependency.md](decisions/0011-harness-is-a-document-not-a-dependency.md).

## The files (read in this order)

| file | what it is for | audience |
|---|---|---|
| `AGENTS.md` | the only rules file an agent must obey. `CLAUDE.md` is a symlink to it | agents |
| `specs/DoD.md` | the single Definition of Done, referenced never copied | agents |
| `specs/NNNN-<slug>/spec.md` | one deliverable: status, stories, Given/When/Then criteria, invariants, out of scope | agents + humans |
| `specs/NNNN-<slug>/tasks.md` | the checklist with priorities, sub-tasks and `D-XX` links | agents |
| `specs/TRACKS.md` + `specs/NNNN-<slug>/handoff.md` | the live-track index and per-lane handoffs carrying unfinished work across sessions | agents |
| `DEBT.md` | the debt register: id, severity, evidence, closure criterion | humans |
| `decisions/NNNN-*.md` | one page per irreversible decision | humans |
| `docs/`, `README.md` | the product for people | humans |
| `scripts/verify-docs.ts` | the proof-marker gate | machine |
| `Taskfile.yml` | the command surface | both |

The invariant that holds it all together: **agents and humans read different
files, and the machine checks the bridge between them.** An agent edits code;
a human reads `README.md`; `task check` fails when a `<!-- proof: ... -->`
marker in the human docs points at code that no longer exists.

## Where the ideas came from

The shape is OpenSpec, the rigor is spec-kit, the separation is Agent OS, the
roles are a light touch of BMAD, and the two halves of the lane lifecycle are
SDD and HDD — all reduced to Markdown, because the harness is the files, not a
tool.

| source | what we kept | what we deliberately dropped |
|---|---|---|
| OpenSpec | `specs/` as the current truth; one spec = one deliverable; archive after shipping | the CLI, the change/archive machinery as a binary |
| Agent OS | standards (`AGENTS.md`, `DoD.md`) live apart from specs and are never copied into them | the layered .md hierarchy, the role scaffolding |
| spec-kit | the discipline: constitution → specify → plan → tasks → implement; **acceptance criteria must be executable** (test name / eval case / SQL) | the 300-line templates, slash-command bindings |
| BMAD | work has roles (analyst/PM/architect/dev/QA) and story files | the role agents themselves |
| SDD (spec-driven development) | the lane contract: `specs/NNNN-<slug>/spec.md` is the deliverable, its acceptance criteria are the test names that must pass; code and its spec ship in the same session | the heavyweight ceremony (proposal/solution docs, a change-management CLI) |
| HDD (handoff-driven development) | work tracks + handoffs: `specs/TRACKS.md` indexes live tracks, a lane's `handoff.md` carries unfinished work across sessions, closing distills the outcome into `specs/TRACKS-LOG.md` | HDD's as-built spec genres and its `specs-audit.py` (our audit is `checkTracks` inside the existing proof gate) |

**How to use the two halves.** SDD answers *what to build next*: pick the lane,
read its spec, make its acceptance criteria pass. HDD answers *how not to lose
the thread*: at session start load the lane's handoff (`specs/TRACKS.md` →
`handoff.md`), at session end update it; when the lane ships, close the track
(outcome → `specs/TRACKS-LOG.md`, delete the handoff). The mechanics are
§Work tracks and handoffs and §How to start a task; the rules an agent obeys
are in `AGENTS.md`.
<!-- proof: specs/TRACKS.md -->
<!-- proof: specs/0015-handoff-driven-development/spec.md -->
<!-- proof: src/platform/docs-proof.ts:checkTracks -->
<!-- proof: AGENTS.md -->

And the thing that is ours, not borrowed: **documentation is verified by the
build**. `task check` runs `verify-docs.ts`, which resolves every
`<!-- proof: path[:symbol|#test] -->` marker against the real tree. A claim
with no evidence, or evidence that went stale, fails the gate. This is the
harness's answer to "the docs lied" — it is the bug this project's refactor
existed to remove.

## Work tracks and handoffs

Borrowed from handoff-driven development
(https://github.com/yetanothervan/handoff-driven-development): specs stay
true, and **handoffs carry unfinished work across sessions**. `specs/TRACKS.md`
indexes the live tracks (one line: essence, handoff link, status, next). A lane
whose work is unfinished keeps `handoff.md` next to its `spec.md` — context,
what to load (and what NOT to load), state, decisions, first step. A session on
a track ends by updating the handoff and its index line; closing a track
distills the outcome into `specs/TRACKS-LOG.md` and deletes the handoff.
`task check` verifies the index stays truthful (no dead links, no missing
status) — the same machine check that guards the proof markers.

## How to start a task (any agent, any model)

1. Read `AGENTS.md` (50 lines). It is the only rules file.
2. Find the deliverable in `specs/`. If it does not exist, write
   `specs/NNNN-<slug>/spec.md` first: status `proposed`, user stories,
   Given/When/Then criteria each naming an executable check, invariants,
   out of scope, and the `D-XX` items it closes.
3. Write `tasks.md` with P0/P1/P2. **P0 blocks shipping; P1 is required for
   the spec to be called done; P2 is a nice-to-have.**
4. Do the work. Commit messages carry `D-XX` or the spec id.
5. Before handing off: `task check` green, the acceptance checks green,
   `tasks.md` ticked, debt ids ticked only on machine-verifiable evidence.
6. A human reviewer reads the diff against the spec's acceptance criteria,
   not against a paragraph.

The branch and commit rules are in `AGENTS.md` (conventional commits,
`lane/<letter>-<slug>`, no `--no-verify`, no force-push to main).

## What "done" means

`specs/DoD.md` — one file, eight items. Two are worth calling out because
they are what keeps this repo honest: (4) RLS verified where the diff touches
data, and (6) every human-docs claim carries a proof marker that resolves.
A lane that is "done" without those two is not done.

## The command surface

`task` with no arguments lists everything. The ones that matter:

| command | what it checks | needs stack |
|---|---|---|
| `task check` | typecheck, lint, unit, deno-check, doc-proofs | no |
| `task verify` | `check` + types-check + e2e + evals | yes |
| `task evals` | the same command CI runs | yes |
| `task check-py` / `task check-infra` | the two self-contained projects | no / no |
| `task infra-plan` | Pulumi plans 23 resources with no credentials | no |
| `task up` | clean clone → running app in one command | starts it |

One-screen version of this page: [`docs/HARNESS-QUICKSTART.md`](HARNESS-QUICKSTART.md).

## Continuing in Claude Code / Codex / anything else

- Point the tool at `AGENTS.md` (Claude Code already reads `CLAUDE.md` →
  `AGENTS.md`; for Codex/Cursor, tell it to read `AGENTS.md` first).
- Ask it to start from a spec, not from a chat description.
- Give it the same feedback a human gets: `task check` is the first
  reviewer, a human is the second.
- The `nextjs-agent-rules` block at the bottom of `AGENTS.md` is
  auto-generated by `next dev` — do not remove it; it is how this version of
  Next.js keeps the agent honest about its own APIs.

## Why this stays in-tree (the extract question)

The harness depends on this project's specifics: the RLS/`correlation_id`/
`run_id` invariants, the Supabase/Deno/Python split, the Taskfile, the
proof-marker paths. A shared package would either carry those specifics
(wrong for other projects) or lose them (wrong for this one). Until there is
a second project, the right extraction point is this document, not a
repository.
