# 0006 — Frontend and Storybook

**Status:** proposed · **Lane:** W2-D · **Debt closed:** D-07, D-41

## Why

- CLAUDE.md demands `*.stories.tsx` while Storybook does not exist — a rule with no implementation (D-07).
- Dead code and duplicates listed by the ponytail audit sit in the UI tree (D-41).

## User stories

**US-01** — As a designer, I want design tokens in one file, so a colour change is one edit, not a grep.
**US-02** — As a maintainer, I want Storybook for shared components and the four dashboard panel states, so UI states are test fixtures, not prose.
**US-03** — As a reviewer, I want the dead-code list gone, so knip has nothing to find.
**US-04** — As an interviewer, I want panel states that cannot lie, so missing, no-verdict and fail stay three distinct states.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a shared component (used by ≥2 surfaces) WHEN it is committed THEN a co-located `*.stories.tsx` covers default/loading/empty/error and runs as a test via `@storybook/addon-vitest` (D-07)
**AC-02** — GIVEN the four dashboard panels WHEN their stories render THEN default/loading/empty/error states each exist and pass axe (test: `tests/a11y.spec.ts` / Storybook a11y addon, D-07)
**AC-03** — GIVEN `components/` WHEN `grep -rEn "#[0-9a-fA-F]{3,8}\b|[0-9]+(\.[0-9]+)?px" components/ --include="*.tsx" --include="*.ts"` runs THEN it returns nothing — the design-token gate stays real (existing test, D-41 hygiene)
**AC-04** — GIVEN the repo WHEN knip runs in CI THEN no dead exports; the ponytail list (`citableIds`, `CardFooter`, `@radix-ui/react-slot`, `hashText`/`hashPayload`, `PRICE_TABLE_VERSION`, `ToolName`, `resetMockProviderState`, `AGENT_MODEL`, `emptySteps`) is removed (D-41)
**AC-05** — GIVEN a chat panel skeleton WHEN a turn streams THEN the UI renders a streaming skeleton without blocking the rest of the page (D-44 frontend half; backend streaming is unowned — see lane report)

## Invariants

- Design tokens live in one file; no hardcoded hex/px in a component.
- One-off page sections need no story; shared components always do.
- The Data Health panel keeps missing / no-verdict / fail as three states.
- Storybook is a test source, not a second frontend project.

## Out of scope

- Full visual polish, animation, mobile layout, i18n.
- Backend streaming/cancel/memory (D-44 backend — needs an owner).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W2-D).
