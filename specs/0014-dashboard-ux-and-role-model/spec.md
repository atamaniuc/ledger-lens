# 0014 — Dashboard UX, Role Model and Ops Docs

**Status:** in progress · **Lane:** W6 (sequential) · **Debt closed:** D-56..D-60 (new)

## Why

- The app has no signed-in shell: no nav, no logout, no visible identity (D-56).
- Invoices are only browsable by cursor; operators need customer/status filters (D-57).
- Three roles exist in code (admin/member/viewer) but only two were seeded and no doc explains routes, roles or credentials (D-58).
- Architecture, patterns and manual-QA knowledge is implicit in code, so a human reviewer or a fresh agent cannot verify or reproduce it (D-59, D-60).

## User stories

**US-01** — As any signed-in user, I want a persistent app shell (identity, navigation, logout), so I know who I am and where I can go.
**US-02** — As an operator, I want to filter invoices by customer and status, so I can find a specific invoice without paging through everything.
**US-03** — As a maintainer, I want seeds and docs that name every role (admin/member/viewer), every route, and every credential, so onboarding and testing are reproducible.
**US-04** — As a reviewer, I want C4 diagrams, a patterns/paradigms doc, and a manual QA runbook, so I can verify the system without reading all code.
**US-05** — As a human or another agent, I want a handoff doc that says exactly what is done and what is next, so work can resume outside this session.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN any signed-in page WHEN the shell renders THEN it shows the user's email, a nav (Dashboard, Admin where permitted) and a logout control; axe is clean (components test panels.test.tsx, app-header, logout-button, D-56)
**AC-02** — GIVEN /dashboard?q=&status= WHEN submitted THEN InvoicesTable filters rows by customer ilike and status eq, keeps pagination, and offers a Clear link when filtered (vitest fetchInvoicePage + dashboard page test, D-57)
**AC-03** — GIVEN supabase db reset WHEN run THEN seeds contain alice@acme.test (admin), bob@globex.test (member), carol@acme.test (viewer), all password 'password123'; RLS lets each see exactly their org's rows (tests/helpers/db.ts CAROL, stage4-auth.spec.ts, D-58)
**AC-04** — GIVEN docs/ACCOUNTS.md WHEN read THEN it lists every route with its auth rule and every role with credentials; claims carry proof markers (scripts/verify-docs.ts in task check, D-58)
**AC-05** — GIVEN docs/ARCHITECTURE-C4.md WHEN read THEN it contains Context, Container and Component diagrams (mermaid) with <=100-word captions and links c4model.com; README links to it (verify-docs pattern, D-59)
**AC-06** — GIVEN docs/PATTERNS.md WHEN read THEN it names the patterns actually used (vertical feature slice, ports & adapters at real boundaries, tactical DDD value objects, invariants in Postgres) and states what is deliberately NOT used (D-59)
**AC-07** — GIVEN docs/QA-MANUAL.md WHEN followed THEN an operator can run every role scenario (login, dashboard, filters, admin settings, copilot demo mode) with acceptance criteria and feature-flag combinations (D-60)
**AC-08** — GIVEN the lane's closed track record in specs/TRACKS-LOG.md WHEN another agent starts THEN it can see the lane outcome; the handoff that carried the uncommitted state while the lane was active was distilled there on close (D-60, spec 0015)

## Invariants

- No service_role in client code; RLS remains the only scoping mechanism.
- Docs never claim behaviour the code does not have (proof markers in task check).
- Feature flags (guardsEnabled, demoMode) are documented as-is, never softened for a passing run.

## Out of scope

- New features beyond the signed-in shell and invoice filtering.
- Visual redesign or design-token changes.
- Deploy (tracked separately, blocked on VERCEL_API_TOKEN).

## Tasks

See tasks.md (P0 gates the lane; ticked only against the DoD).
