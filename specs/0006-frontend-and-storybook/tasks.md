# 0006 — Tasks

Lane owner: **W2-D**. Debt: D-07, D-41. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** Storybook init + `@storybook/addon-vitest`; stories run as tests (D-07)
- [ ] **T2** Stories for shared components and the 4 dashboard panel states; axe checks (D-07)
- [ ] **T3** Design tokens consolidated to one file; token gate extended if needed (D-41 hygiene)
- [ ] **T4** Remove the ponytail dead-code list; `knip` wired into CI (D-41)
- [ ] **T5** Chat panel streaming UI skeleton (stub endpoint or SSE consumer)

## P1

- [ ] **T6** Vitest browser mode for component tests (alongside Storybook)
- [ ] **T7** Skeleton/empty/error states pass visual regression in Storybook

## P2

- [ ] **T8** Accessibility pass: keyboard nav and focus order on lineage drawer and chat panel

