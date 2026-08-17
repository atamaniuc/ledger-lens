# LedgerLens — Claude Code Workflow Rules

## Project
Data ingestion → transform → quality/reconciliation → Next.js dashboard + RAG agent.
Stack: Postgres/Supabase (RLS by `org_id`, pgvector HNSW), Next.js, ingestion/transform jobs, evals w/ CI threshold.
Every table: RLS on. Every log line: `correlation_id`. Every data row: `run_id`.

## Repo Zones
Two parts of this repo, different rules:

- **`interview-preps/`** — personal interview-prep materials (JD breakdown, Q&A banks, pet-project spec, cheatsheet). **Gitignored — not part of this repository's tracked history or deliverable.** Local reference only. Not code, no PRD/ADR/tasks.md gate — edit directly.
  - Regenerate/extend this pack via the `interview-prep-from-jd` skill (user scope), not ad-hoc.
  - Content stays normal, readable prose always. `/caveman-compress` only on explicit request — never automatic.
  - The repo's actual deliverable — everything that gets committed — is English-language project docs (`docs/`, `.claude/PRD.md`, `.claude/adr/`, `README*.md`) and the meta-harness (`scripts/harness/`), plus, eventually, the implemented, deployed, and verified LedgerLens pet project itself.
- **Everything else** — LedgerLens app code and its docs. Full pipeline below (Phase 0 → 1 → 2) applies.

**Always push/deploy-ready:** the working tree should be in a state that could be pushed and deployed at any point, not just at the end. Concretely: no load-bearing link from a committed doc into the gitignored `interview-preps/` zone (context/flavor mentions are fine, requirements aren't), no secrets in the diff, `.gitignore` current. See `docs/DEPLOYMENT.md`'s readiness checklist — run it before any push, not just before a release.

## Workflow at a Glance
```
PRD (what & why)  →  Design + ADR (how, Superpowers)  →  tasks.md (OMC)
      Phase 0              Phase 1                          Phase 2
                                                                │
                                          ┌─────────────────────┘
                                          ▼
                        Delegation Ladder: locate → execute → review
                                          │
                                          ▼
                              Definition of Done  →  commit
```
Read down for the detail behind each step.

## Roles Allocation
- **Architecture & Design:** `superpowers`, for architectural decisions and bootstrapping complex tasks (new pipeline stage, new agent tool, schema change). Code zone only.
- **Task Breakdown & Multi-Agent Execution:** `OMC`, to break down approved architecture into atomic tasks and orchestrate sub-agents. Code zone only.
- **Narrow Execution:** `caveman:cavecrew` (`cavecrew-investigator` / `cavecrew-builder` / `cavecrew-reviewer`) — the cheap, fast option OMC reaches for on small atomic tasks. Detail in Delegation Ladder below.
- **Output Style:** Caveman (terse) applies to **chat replies only**. It never touches persisted content — code comments, commit messages, PR text, `.claude/PRD.md` / `DESIGN.md` / `adr/*`, or anything under `interview-preps/`. Those always stay normal prose.

## Phase 0: Product Requirements (PRD)
1. New feature/stage with no existing `.claude/PRD.md` entry: write one first — problem, user, success criteria, non-goals. Keep it short, one page per feature.
2. Store at `.claude/PRD.md` (append per feature as `## <feature>` section, or `.claude/prd/<feature>.md` if it grows large).
3. No design work starts without a PRD entry — even one paragraph counts, but it must exist.

## Phase 1: High-Level Design (Superpowers)
1. On design request, use `/superpowers:brainstorming`.
2. Generate 2-3 distinct trade-off approaches.
3. Save approved architecture into `.claude/DESIGN.md`.
4. Chosen approach + rejected alternatives + reasoning → new ADR at `.claude/adr/NNNN-<title>.md` (sequential number, format: Context / Decision / Consequences / Alternatives considered).
5. STOP, wait for user confirmation before coding.

## Phase 2: Orchestration & Coding (OMC)
1. Read `.claude/DESIGN.md`.
2. Run `/omc-plan --consensus` — spin up Planner/Architect/Critic loop, generate `tasks.md`.
   - For architecture/security-sensitive stages (auth, RLS/RBAC changes, agent tool surface, schema migrations touching multiple orgs): route Architect and/or Critic through Codex as a second model opinion — `/omc-plan --consensus --architect codex --critic codex`. Requires `codex` CLI installed (`which codex` to check).
   - Either flag can be used alone (e.g. `--critic codex` only) when just one pass needs the outside opinion.
   - If `codex` isn't available, OMC falls back to the default Claude Architect/Critic for that stage — note it happened, don't silently skip the review.
3. Execute via OMC sub-agents, minimal tokens — see Delegation Ladder for which sub-agent does what.

## Delegation Ladder
How an individual `tasks.md` item actually gets done, code zone only:
1. **Locate** — `cavecrew-investigator` answers "where is X / what calls Y." Skip this step if the site is already known.
2. **Execute** — scope ≤2 files, surgical change → `cavecrew-builder`. Scope 3+ files or cross-cutting → OMC `executor`/`architect` subagent instead (`cavecrew-builder` will just refuse a task that big — don't force it).
3. **Verify** — `cavecrew-reviewer` audits every diff before commit. Swap in `code-reviewer` (vanilla) when the diff needs architectural rationale, not just a findings list.
4. Step 3 is not optional polish — it's Definition of Done item 3. Don't skip it to close a checkbox faster.

## Parallel Execution: Git Worktrees
When OMC dispatches 2+ independent `tasks.md` items at once (`superpowers:dispatching-parallel-agents`, `/team`), each parallel agent gets its own git worktree — never share one working tree across concurrent agents. Reason: migrations, generated types, and lockfiles collide silently when two agents write the same tree at once; a bad merge there is worse than the time saved.

1. Before dispatch, check the task list for shared-file overlap. Only dispatch in parallel if scopes don't touch the same files/migrations — sequential otherwise, worktrees don't fix a real dependency.
2. Create isolation via `superpowers:using-git-worktrees` — one worktree per branch, branch name per Branch & Commit Convention (`stage-N-<short-desc>`).
3. Each agent commits inside its own worktree only. `.claude/DESIGN.md`/`tasks.md` updates that need to be visible to all agents happen on the base branch, not inside a worktree.
4. On task completion: `superpowers:finishing-a-development-branch` handles merge-back and worktree cleanup — don't leave stale worktrees after a branch merges.
5. Migrations are the one thing that must stay sequential even across worktrees — two agents writing conflicting migration files in parallel is a merge conflict Postgres can't resolve for you. Gate migration-touching tasks through a single agent/worktree at a time.

## Domain-Specific Rules
- Any table/RLS/migration/pgvector work: load `supabase:supabase-postgres-best-practices` skill BEFORE writing SQL — even for a one-column change.
- No RLS bypass, no `service_role` key in client code, no cross-`org_id` query without explicit filter.
- Agent tools: scoped, user-permission-checked. Every agent step → `audit_log` row.
- Evals: new agent behavior ships only with a dataset case + CI threshold check. No exceptions.
- Ingestion jobs: idempotent, cursor-based. No reprocessing without cursor reset justified in commit msg.
- Mock provider failure modes (dupes, drift, 429, 500) stay as regression tests — don't remove/soften them to make pipeline "pass".

## Definition of Done
Task not done until:
1. Migration applied clean, `get_advisors` (security+performance) checked — no new warnings.
2. Tests pass (unit + eval dataset if agent/RAG touched).
3. `cavecrew-reviewer` (or `code-reviewer` for rationale-level review) ran on the diff, findings resolved.
4. RLS verified: query as non-owner `org_id` returns empty, not error-masked data.
5. `tasks.md` item checked off, `.claude/DESIGN.md` updated if scope drifted from plan.
6. No secrets, no `service_role` key, in diff.
7. Architecture decision changed mid-task? New ADR, don't silently edit an old one — supersede it (`Status: Superseded by NNNN`).

## Frontend: Design System & Storybook
- Any new dashboard UI (metrics tile, freshness badge, lineage drill-down, chart) → `designer` agent, not ad-hoc component code.
- Charts/metrics/heatmaps/sparklines: load `dataviz` skill before coding — color, form, accessibility rules for the LedgerLens dashboard.
- Component inventory lives in Storybook. New reusable component ships with a co-located `*.stories.tsx` in same PR — no exceptions, no "add story later".
- Story per component covers: default state, loading, empty, error (data-quality-flagged) — dashboard shows freshness/quality badges, so error/stale states are first-class, not edge cases.
- Design tokens (colors, spacing, badge states) centralized — no hardcoded hex/px in components. Update tokens file, not per-component overrides.
- Visual changes to shared components → screenshot before/after in PR description.

## Branch & Commit Convention
- Branch: `stage-N-<short-desc>` matching Этап N from roadmap (e.g. `stage-3-reconciliation`).
- Commits: Conventional Commits — `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Scope in parens when useful: `feat(ingestion): cursor-based resume`.
- One logical change per commit. Migration + its RLS policy + its test = one commit, not three.
- No `--no-verify`, no force-push to main.
- PR description: link `tasks.md` item, list which DoD checks ran.
