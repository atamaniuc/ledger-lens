---
name: design
description: Write and update the approved architecture in .claude/DESIGN.md — components, data flow, error handling, testing plan — per CLAUDE.md Phase 1 step 3, scaffolded via scripts/harness/new-design-section.sh. Use once /superpowers:brainstorming has converged on one approach for a feature/stage and it's time to write the design down, or when scope drifted during implementation and the design doc needs updating to match reality.
argument-hint: "[feature or stage name]"
---

# Design Skill

Write down the architecture that `/superpowers:brainstorming` converged
on. This is the artifact that answers "how does this actually fit
together" for a feature/stage — distinct from the PRD (which answers
"why") and the ADR (which records "why this option and not the others").
A `.claude/DESIGN.md` section that just restates the PRD's success
criteria in different words isn't a design — it's supposed to say how the
pieces connect.

## How this relates to PRD and ADR

- **PRD** (`.claude/PRD.md`) — problem, user, success criteria, non-goals.
  Answers *why*. Written first (Phase 0), via the `prd` skill.
- **DESIGN** (`.claude/DESIGN.md`, this skill) — components, data flow,
  error handling, testing plan. Answers *how*. Written after brainstorming
  converges (Phase 1), before or alongside the ADR.
- **ADR** (`.claude/adr/NNNN-*.md`) — the decision itself and why the
  alternatives lost. Answers *why this way and not another way*. One
  immutable file per decision, via the `adr` skill.

Cross-link them: a DESIGN.md section should reference the PRD entry it
satisfies and any ADR(s) that justify a non-obvious choice; an ADR should
be findable from the DESIGN.md section it applies to. Don't restate PRD
content in DESIGN.md, and don't restate ADR reasoning in DESIGN.md either
— link to it.

## Approach

- **Don't write this until brainstorming has actually converged.** Per
  `CLAUDE.md` Phase 1: `/superpowers:brainstorming` produces 2–3 approaches
  first; DESIGN.md records the one that was approved, not the exploration.
  If you're still weighing options, that's chat/brainstorming territory,
  not this document.
- **One clear purpose per component.** Straight from the brainstorming
  skill's isolation principle: for every component, be able to answer
  *what does it do*, *how do you use it*, and *what does it depend on* —
  without needing to read its internals. If you can't answer those three
  cleanly, the component boundary needs work before it goes in the doc.
- **Cover architecture, components, data flow, error handling, and
  testing** — the same five things `/superpowers:brainstorming` requires
  when presenting a design. This skill exists to make sure that coverage
  actually lands in a file, not just in the conversation that approved it.
- **DESIGN.md is a living document, unlike an ADR.** `CLAUDE.md`
  Definition of Done item 5 expects it to be updated in place when scope
  drifts mid-implementation. Updating a section is normal maintenance —
  but if the update is actually a reversed architectural decision, not a
  refinement, it still needs its own ADR (see the `adr` skill); don't let
  a silent DESIGN.md edit stand in for that.
- **Keep it implementable, not aspirational.** Every component/data-flow
  claim should be concrete enough that someone could start coding from it
  without another round of questions.

## Before generating: ask, one question at a time

1. Which PRD entry does this design satisfy? (Link it.)
2. What did brainstorming converge on — the one-sentence version?
3. What are the components, and for each: what does it do, how is it
   used, what does it depend on?
4. What's the data flow between them, start to finish?
5. What fails, and what happens when it does — for each component that
   can fail independently?
6. What does "this works" look like as a test — unit, integration, or
   both?
7. Any open questions or risks that don't block writing this down but
   should be visible?

## Scaffolding

```bash
scripts/harness/new-design-section.sh "Mock Provider"
# → empty skeleton section in .claude/DESIGN.md

task design FEATURE="Mock Provider"

# update in place once real content exists (normal for this file — see
# "DESIGN.md is a living document" above):
scripts/harness/new-design-section.sh --force "Mock Provider" <<'EOF'
**PRD:** .claude/PRD.md#mock-provider
**ADR(s):** .claude/adr/0002-mock-provider-layout.md

**Overview:**
...
EOF
```

## Section structure

Matches the skeleton `new-design-section.sh` writes:

```markdown
## <Feature>

**PRD:** link to the .claude/PRD.md section this satisfies.
**ADR(s):** link any ADR(s) that justify a non-obvious choice here.

**Overview:**
One paragraph — what this feature does and how it fits the bigger system.

**Components:**
One entry per component. For each: what it does, how it's used, what it
depends on. Small and well-bounded beats one component that does
everything.

**Data flow:**
Start to finish, through the components above.

**Error handling:**
What fails, per component, and what happens when it does.

**Testing plan:**
Unit / integration / e2e as applicable — concrete enough to write from.

**Open questions / risks:**
What's still unresolved. Fine for this to be non-empty — better than
hiding an unresolved question inside a confident-sounding Overview.
```

## After generating

- If a component's boundary or a data-flow decision isn't obvious from
  the requirements alone, that's usually an ADR-worthy decision — record
  it with the `adr` skill and link it from here, rather than justifying
  it inline in the Overview.
- For architecture/security-sensitive designs (auth, RLS/RBAC, agent tool
  surface, cross-tenant data flow): get a second opinion before treating
  the design as final — `task codex-architect PROMPT_FILE=.claude/DESIGN.md`
  and/or `task codex-critic PROMPT_FILE=.claude/DESIGN.md`.
- Once approved, this is what `/omc-plan --consensus` reads (Phase 2,
  `CLAUDE.md`) to generate `tasks.md` — keep it accurate, since the plan
  is only as good as the design it's built from.
