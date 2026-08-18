---
name: adr
description: Write and maintain Architecture Decision Records for this repo — Context/Decision/Consequences/Alternatives considered, one sequential file per decision under .claude/adr/, scaffolded via scripts/harness/new-adr.sh. Use when starting Phase 1 design work per CLAUDE.md, when an architectural decision has actually been made and needs recording, or when an earlier decision changes and must be superseded rather than silently edited.
argument-hint: "[decision title]"
---

# ADR Skill

Record architectural decisions for LedgerLens the way `CLAUDE.md` requires:
one file per decision, sequentially numbered, with the reasoning that
didn't make the cut recorded alongside the reasoning that did. An ADR
without honest alternatives and honest consequences is just an
announcement — this skill is about writing the version that's actually
useful six months later when someone asks "why did we do it this way."

## Approach

- **Write simply.** Same bar as the `prd` skill: a new contributor should
  understand the decision and its cost without needing side context.
- **One decision, one file.** Don't bundle two unrelated decisions into
  one ADR because they landed in the same PR — split them.
- **Record after convergence, not during exploration.** An ADR documents
  a decision that's actually been made (per `CLAUDE.md` Phase 1, after
  `/superpowers:brainstorming` has produced 2–3 approaches and one has
  been chosen), not a brainstorm-in-progress. If the decision isn't final
  yet, this isn't the right moment to scaffold the ADR.
- **Consequences must include real costs, not just benefits.** A
  Consequences section that's all upside means the alternatives weren't
  taken seriously. See [ADR 0001](../../.claude/adr/0001-infrastructure-as-code-with-pulumi.md)
  in this repo for the calibration example: it states plainly that mixing
  native and command-wrapped Pulumi resources means only *some* of the
  infra gets real drift detection — a real limitation, not smoothed over.
- **Alternatives considered must be real alternatives.** Each one gets an
  honest reason it was rejected, not a strawman. If an alternative was
  actually close, say so.
- **Never silently edit an old decision.** Per `CLAUDE.md` Definition of
  Done item 7: if a decision changes, the old ADR's `Status` line becomes
  `Superseded by NNNN` — a separate, visible edit — and a *new* ADR
  records the new decision plus why the old one no longer holds. Editing
  the old ADR's Context/Decision sections in place to match the new
  reality erases the history the ADR exists to preserve.

## Before generating: ask, one question at a time

1. What's the decision, in one sentence?
2. What's the context forcing this decision — what problem, constraint, or
   discovery made the previous approach (if any) untenable?
3. What alternatives were seriously considered, and why was each one
   rejected? (Not "we didn't think of it" — real trade-offs.)
4. What does this cost, not just what does it buy? Maintenance burden, new
   dependency, weaker guarantee somewhere, added complexity?
5. Does this supersede an existing ADR? If yes, which number?

## File & numbering convention

Always scaffold through the harness — never hand-create the file, numbers
collide easily by hand:

```bash
scripts/harness/new-adr.sh "short decision title"
# → .claude/adr/NNNN-short-decision-title.md

task adr TITLE="short decision title"

# when this decision replaces an earlier one:
scripts/harness/new-adr.sh "new decision title" --supersedes 0003
# appends a reminder to mark ADR 0003 Superseded by NNNN — you still
# have to go make that edit to 0003 yourself, deliberately
```

## ADR structure

Matches the skeleton `new-adr.sh` writes — fill in each section, don't
leave any as a placeholder:

```markdown
# NNNN: <Decision title>

Status: Proposed | Accepted | Superseded by NNNN

## Context

What situation, constraint, or new information made a decision necessary?
Include what was true before, if this changes an earlier call — a reader
should understand why the old answer stopped being good enough without
needing to dig up the previous ADR first.

## Decision

What was decided, stated as an action, specifically enough that someone
could implement it from this section alone.

## Consequences

What this costs and what it buys — both directions, honestly. Include at
least one real limitation or trade-off, not just benefits.

## Alternatives considered

Each alternative gets its own bullet/subsection: what it was, and the
specific reason it lost. "Simpler but doesn't hold up once X" is a real
reason. "Not chosen" with no reason is not.
```

## After generating

- For architecture/security-sensitive decisions (auth, RLS/RBAC, agent
  tool surface, cross-tenant migrations, infra changes touching secrets):
  get a second opinion before treating the ADR as final —
  `task codex-architect PROMPT_FILE=.claude/adr/NNNN-....md` and/or
  `task codex-critic PROMPT_FILE=...`.
- If this decision changes something already stated in `.claude/PRD.md`
  or `.claude/DESIGN.md`, update those in the *same* change as the ADR —
  per `CLAUDE.md`, don't leave the PRD/design docs describing the old
  decision while the ADR says otherwise.
- If this ADR supersedes an earlier one, go make that edit to the old
  ADR's `Status` line now — the harness reminds you, it doesn't do it for
  you.
