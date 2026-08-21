# 0014 — Tasks

Lane owner: **W6 (sequential)**. Debt: D-56..D-60. P0 gates the lane; P1 follows. One batch = one commit; message carries the D-XX or spec id. Ticked only against the DoD (specs/DoD.md).

## P0

- [x] **T1** App shell: AppHeader (email + nav) and LogoutButton on /dashboard and /admin (D-56)
- [x] **T2** Invoice filters: fetchInvoicePage filters, /dashboard searchParams wiring, GET filter form + Clear (D-57)
- [x] **T3** Seeds: alice admin / bob member / carol viewer, all password 'password123'; CAROL constant; db reset applied (D-58)
- [x] **T4** docs/ACCOUNTS.md — routes + roles + credentials with proof markers (D-58)
- [x] **T5** docs/ARCHITECTURE-C4.md (Context/Container/Component mermaid, c4model.com link) + README link (D-59)
- [x] **T6** docs/PATTERNS.md — patterns used and explicitly not used (D-59)
- [x] **T7** docs/QA-MANUAL.md — per-role manual scenarios, acceptance criteria, flag combinations (D-60)
- [x] **T8** docs/HANDOFF.md — resume point for Claude Code/Codex (D-60)

## P1

- [ ] **T9** Empty-state copy for zero-result filters (distinct from the no-invoices-yet state)
- [ ] **T10** Focus-visible sweep across the new form controls (axe covers basics; visual pass by human)

## P2

- [ ] **T11** View-only e2e: viewer sees dashboard, is redirected away from /admin
