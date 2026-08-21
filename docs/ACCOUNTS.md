# Accounts, Routes and Roles

Everything about who can sign in, what each role can reach, and the credentials the seeds create. Companion to docs/QA-MANUAL.md (manual scenarios) and docs/HARNESS.md (how specs map to lanes).

## Roles

Three roles exist, enforced by RLS on the user's org membership — there is no role column on the user:

| Role | Meaning | Enforced by |
| --- | --- | --- |
| admin | Everything in their org, plus org-wide copilot settings and budget overrides | `memberships.role = 'admin'` + server checks |
| member | Reads and works with their org's data | RLS on membership |
| viewer | Read-only view of their org's data | RLS on membership |

Role checks live in the client-safe path only; every database read is scoped by RLS through the user's JWT. No client code ever holds `service_role`.

## Routes

| Route | Auth | Roles | Purpose |
| --- | --- | --- | --- |
| `/login` | public | — | Email/password sign-in (registration closed, D-20) |
| `/auth/callback` | public | — | PKCE callback that completes the session |
| `/dashboard` | signed-in | admin, member, viewer | Home: KPI tiles, freshness, invoice list with search/filter, copilot panel |
| `/admin` | signed-in | admin only | Copilot settings: guardsEnabled, demoMode, runtime providers, budgets |
| `/api/agent/chat` | signed-in | admin, member, viewer | SSE copilot stream (RLS-scoped tools) |
| `/api/admin/copilot-settings` | signed-in | admin only | GET/PUT for the settings above |

Non-admin visitors to `/admin` are redirected to `/dashboard`.

## Credentials (seeds)

`supabase db reset` creates three users, all with password `password123`, one per role and split across two orgs so cross-org isolation is testable:

| Email | Role | Org | Notes |
| --- | --- | --- | --- |
| alice@acme.test | admin | Acme | Full control; the demo presenter account |
| bob@globex.test | member | Globex | Works with data, cannot touch settings |
| carol@acme.test | viewer | Acme | Read-only in the same org as alice |

Seeds are in `supabase/seed.sql`; the viewer constant used by tests is `CAROL` in `tests/helpers/db.ts`.
<!-- proof: supabase/seed.sql -->
<!-- proof: tests/helpers/db.ts:CAROL -->
<!-- proof: src/app/login/page.tsx -->
<!-- proof: src/app/dashboard/page.tsx -->
<!-- proof: src/app/admin/page.tsx -->
<!-- proof: src/app/api/admin/copilot-settings/route.ts -->
