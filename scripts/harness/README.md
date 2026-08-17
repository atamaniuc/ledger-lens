# scripts/harness — what this is and why

A set of small shell scripts that mechanically service the workflow defined in the root [`CLAUDE.md`](../../CLAUDE.md): PRD → Design/ADR (Superpowers) → tasks.md (OMC) → parallel execution via git worktree → second opinion from Codex → review. Each script isn't a "framework" — it's a thin wrapper around `git`/`omc ask` that just keeps you from forgetting a step or doing it by hand with a mistake (ADR numbering, PRD path, worktree path — always consistent).

All scripts are already executable (`chmod +x`) and can be called either directly (`scripts/harness/<script>.sh ...`) or through the `Makefile` at the repo root (`make <target> ...`) — shorter to type and you don't need to remember exact filenames.

**Important up front:** the scripts resolve the repo root relative to **their own path on disk**. If you're working inside a git worktree (see below), it has its own checkout of `scripts/harness/*`. Run the script **from the tree you're currently in** (`./scripts/harness/...` from the current tree's root) — don't reach into a script from a sibling tree via `../../scripts/...`. Hit this once during testing: the command ran fine, but wrote a PRD section into `main` instead of the isolated worktree. Not a bug in the script — a bug in how it was invoked, but a real footgun.

---

## Quick reference: which script, when

| I want to | Script | Make target |
|---|---|---|
| Start a design decision for a new feature/stage | `new-adr.sh` | `make adr TITLE="..."` |
| Open a PRD entry before starting design (Phase 0) | `new-prd-section.sh` | `make prd FEATURE="..."` |
| Start work on a `tasks.md` item, isolated | `new-worktree.sh` | `make worktree BRANCH=...` |
| Finish a task, clean up its worktree | `finish-worktree.sh` | `make worktree-done BRANCH=...` |
| Get a second opinion from Codex (architect/critic) | `ask-codex.sh` | `make codex-architect PROMPT_FILE=...` / `make codex-critic PROMPT_FILE=...` |
| Run the current diff past Codex as a reviewer | `codex-review.sh` | `make codex-review [REF=...]` |

---

## `new-adr.sh` — create an Architecture Decision Record

**Why:** CLAUDE.md, Phase 1, step 4 — every architectural decision (chosen approach + rejected alternatives + reasoning) belongs in `.claude/adr/NNNN-<title>.md` with a sequential number. Easy to get the number wrong by hand, or to forget one of the four required sections (Context / Decision / Consequences / Alternatives considered).

**What it does:**
1. Looks at existing `.claude/adr/NNNN-*.md` files, takes the highest number, adds 1 (starts at `0001` if none exist yet).
2. Turns the title into a slug (lowercase, spaces/special chars → hyphens).
3. Writes a skeleton file with the heading, `Status: Proposed`, and four empty sections.
4. Refuses to overwrite a file if that number/name already exists (protects against a race between parallel agents).

**Usage:**
```bash
scripts/harness/new-adr.sh "cursor-based ingestion resume"
# → .claude/adr/0001-cursor-based-ingestion-resume.md

# via Makefile:
make adr TITLE="cursor-based ingestion resume"
```

**Replacing/superseding an old decision** (CLAUDE.md Definition of Done, item 7 — an old ADR is never silently edited, it gets marked superseded):
```bash
scripts/harness/new-adr.sh "switch to Modal for GPU workloads" --supersedes 0003
```
This appends a reminder line to the new ADR ("mark ADR 0003 as `Superseded by 000N`") — the script does not touch file `0003` itself; that's a separate, deliberate step by hand (or by an agent), not automated.

**When NOT to use it:** for `interview-preps/*` — no ADRs there, it's not the code zone (see Repo Zones in CLAUDE.md).

---

## `new-prd-section.sh` — open a PRD entry

**Why:** CLAUDE.md, Phase 0 — no design work starts without an entry in `.claude/PRD.md` (problem, user, success criteria, non-goals). It's a gate, not bureaucracy: forces you to state "why" before "how."

**What it does:**
1. Creates `.claude/PRD.md` with a heading if it doesn't exist yet.
2. Checks whether a `## <feature>` section with that exact name already exists.
3. **Interactive (no piped stdin):** appends an empty skeleton — Problem / User / Success criteria / Non-goals — for you to fill in by hand.
4. **Piped stdin:** writes whatever you pipe in as the section body verbatim, under the `## <feature>` heading. This is what makes it usable for scripted/agent-driven PRD writing instead of only hand-editing — an agent (or you, via a heredoc) can generate the full Problem/User/Success criteria/Non-goals content and hand it straight to the script.
5. Refuses to duplicate an existing section unless you pass `--force`, in which case it replaces that section's content in place (used to go from an empty skeleton to real content without hand-editing the file, or to revise a section later).

**Usage:**
```bash
scripts/harness/new-prd-section.sh "Mock Provider"
# → empty "## Mock Provider" skeleton in .claude/PRD.md

make prd FEATURE="Mock Provider"

# replace with real content, e.g. from a heredoc:
scripts/harness/new-prd-section.sh --force "Mock Provider" <<'EOF'
**Problem:**
...
**User:**
...
**Success criteria:**
...
**Non-goals:**
...
EOF
```

**Order in the real workflow:** `new-prd-section.sh` first (Phase 0), fill it in by hand/with an agent, then `/superpowers:brainstorming` → `new-adr.sh` (Phase 1), then `/omc-plan --consensus` → `tasks.md` (Phase 2).

---

## `new-worktree.sh` — isolated working tree for one task/agent

**Why:** CLAUDE.md, "Parallel Execution: Git Worktrees" section. When OMC dispatches 2+ independent `tasks.md` items in parallel, each agent needs its own copy of the repo — otherwise migrations, lockfiles, and generated types silently collide when two agents write to the same tree at once.

**What it does:**
1. Checks that you're inside a git repository at all, and that it has at least one commit (`git worktree` can't branch off empty history — it says so plainly instead of failing with a confusing git error).
2. If a branch with that name already exists — just attaches a new worktree to it (doesn't recreate it, doesn't lose history).
3. If the branch doesn't exist — creates a new branch from the given base (defaults to the current branch, usually `main`) and a worktree for it right away.
4. Puts the worktree at `.worktrees/<branch>/` inside the repo (that directory is in `.gitignore`, never enters main history).
5. Prints the worktree path to stdout (handy for `cd "$(scripts/harness/new-worktree.sh ...)"`), status messages go to stderr.

**Usage:**
```bash
scripts/harness/new-worktree.sh stage-3-reconciliation
# → .worktrees/stage-3-reconciliation, branch stage-3-reconciliation off main

scripts/harness/new-worktree.sh stage-3-reconciliation develop
# → same branch, but off develop instead of the current branch

make worktree BRANCH=stage-3-reconciliation
```

Then just:
```bash
cd .worktrees/stage-3-reconciliation
# work like a normal repo — its own git status, its own commits,
# invisible in the main tree until merged
```

**On branch naming:** per CLAUDE.md's Branch & Commit Convention — `stage-N-<short-desc>`, matching Этап N from the roadmap in `interview-preps/07_Пет_проект.md`. The script doesn't validate the name format — that discipline is on you/the agent.

**On migrations:** per CLAUDE.md, if a task touches a Postgres migration, it does not get parallelized across worktrees against another migration — sequential only, one worktree at a time. The script doesn't enforce this itself; it's your responsibility when splitting `tasks.md` into parallel batches.

---

## `finish-worktree.sh` — clean up after a merge

**Why:** worktrees left hanging around after their branch is merged are clutter — they crowd `git worktree list` and eat disk space. This script closes exactly that loop, and only that.

**What it does:**
1. Checks that a worktree with that name exists.
2. Checks `git status --porcelain` inside the worktree — if there are uncommitted changes, it **refuses** to remove it (no `--force`, nothing gets lost silently).
3. If clean — `git worktree remove`.
4. Leaves the branch itself **untouched** — you, or `superpowers:finishing-a-development-branch`, decide when to delete it (usually after the PR merges).

**Usage:**
```bash
scripts/harness/finish-worktree.sh stage-3-reconciliation
make worktree-done BRANCH=stage-3-reconciliation

# delete the branch as a separate, deliberate step, once it's actually merged:
git branch -d stage-3-reconciliation
```

**What the script deliberately does NOT do:** merge the branch into `main`, push, or delete the branch. The merge is your call (fast-forward, PR, squash — depends on your conventions); the script only touches the worktree's file checkout.

---

## `ask-codex.sh` — second opinion from Codex

**Why:** CLAUDE.md, Phase 2 — for architecture/security-sensitive stages (auth, RLS/RBAC, agent tool surface, cross-tenant migrations), `/omc-plan --consensus --architect codex --critic codex` routes Architect/Critic through an external model instead of only Claude. This script is the same mechanism (`omc ask codex --agent-prompt <role>`), but as a standalone command you can fire by hand outside a full consensus cycle — e.g. to quickly get an opinion on an already-drafted `.claude/DESIGN.md` without running the whole `/omc-plan`.

**What it does:**
1. Checks that the `codex` CLI is actually installed (`which codex`) — if not, says so immediately and exits, instead of failing silently deeper in.
2. Takes the prompt either from a file (`ask-codex.sh architect .claude/DESIGN.md`) or from stdin (`-`).
3. Calls `omc ask codex --agent-prompt "$ROLE" "$PROMPT"`.

**Usage:**
```bash
scripts/harness/ask-codex.sh architect .claude/DESIGN.md
scripts/harness/ask-codex.sh critic .claude/DESIGN.md
git diff main... | scripts/harness/ask-codex.sh review -

make codex-architect PROMPT_FILE=.claude/DESIGN.md
make codex-critic PROMPT_FILE=.claude/DESIGN.md
```

`role` isn't a hard enum — it's whatever label `omc ask` accepts (`architect`/`critic`/`review`/anything meaningful); it's passed straight into `--agent-prompt`.

---

## `codex-review.sh` — Codex as reviewer of the current diff

**Why:** the Delegation Ladder in CLAUDE.md, step 3 (Verify) — review normally comes from `cavecrew-reviewer` or `code-reviewer`, but an outside model's opinion on the same diff is sometimes worth having — e.g. before committing something risky (an RLS policy, an agent tool). This is a ready-made recipe on top of `ask-codex.sh`, not a separate mechanism.

**What it does:**
1. Takes `git diff <REF>` (defaults to `REF=HEAD`, i.e. uncommitted changes; you can pass `main` or any other commit/branch).
2. If the diff is empty — exits quietly (nothing to review), doesn't spend a Codex call.
3. Builds a prompt: asks for correctness bugs, RLS/security regressions, and missing test coverage — with an explicit pointer to project conventions (RLS on every table, `correlation_id`, `run_id`, idempotent ingestion).
4. Pipes it all into `ask-codex.sh review -`.

**Usage:**
```bash
scripts/harness/codex-review.sh          # diff against HEAD (uncommitted)
scripts/harness/codex-review.sh main     # current branch's diff against main

make codex-review
make codex-review REF=main
```

---

## Full cycle on a real task

How this chains together in practice (manually verified on `stage-1-mock-provider`, see git history):

```bash
# Phase 0 — justify why
make prd FEATURE="Mock Provider"
# → fill in .claude/PRD.md by hand / via the planner agent

# Phase 1 — design it
# /superpowers:brainstorming in Claude Code → .claude/DESIGN.md
make adr TITLE="chaos-flag mock provider design"
# optional — second opinion before treating the design as final:
make codex-architect PROMPT_FILE=.claude/DESIGN.md

# Phase 2 — plan and execute
# /omc-plan --consensus --architect codex --critic codex → tasks.md

# Parallel execution — isolation per task
make worktree BRANCH=stage-1-mock-provider
cd .worktrees/stage-1-mock-provider
#   ...write code, commit INSIDE the worktree, using its own relative path
#   ./scripts/harness/... (not ../../scripts/...!)
make codex-review                # or scripts/harness/codex-review.sh
cd ../..
git merge --ff-only stage-1-mock-provider
make worktree-done BRANCH=stage-1-mock-provider
git branch -d stage-1-mock-provider
```

---

## Common properties across all scripts (in case something goes sideways)

- All written with `set -euo pipefail` — fail on the first error, never keep going blind.
- None of them `git push`, merge, or delete branches without a separate explicit step — destructive/public actions are deliberately left to you.
- `new-adr.sh` and `new-prd-section.sh` resolve the repo root **from their own path on disk** — invoke them via the copy that lives in the tree you're currently working in.
- `new-worktree.sh`, `finish-worktree.sh`, `codex-review.sh` resolve the root via `git rev-parse --show-toplevel` — these work correctly from any subdirectory of the current tree, and aren't subject to the footgun above.
