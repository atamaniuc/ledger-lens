# Manual QA Runbook

Every scenario is run against a local stack (task up, then task seed already applied). All users share the password password123 (docs/ACCOUNTS.md). Before starting: open /admin as alice and confirm the settings page renders — that is scenario S6.

Feature flags that matter: guardsEnabled (off = no 429/402 budget blocks), demoMode (on = copilot always answers deterministically, marked Demo answer), providers (runtime OpenAI-compatible: env var name as the key). Chaos flags (src/features/provider/chaos.ts) are OFF outside dev/test and must stay off for these runs.

## Roles: what each should and should not see

| Role | Login | Dashboard | Admin page | Admin API | Copilot |
| --- | --- | --- | --- | --- | --- |
| admin (alice@acme.test) | yes | yes (Acme data) | yes | yes | yes |
| member (bob@globex.test) | yes | yes (Globex data) | no — redirected to /dashboard | 403 | yes (Globex data) |
| viewer (carol@acme.test) | yes | yes (Acme data) | no — redirected to /dashboard | 403 | yes (read-only view) |

## Scenarios

**S1 — Login and logout.** GIVEN /login WHEN alice signs in with alice@acme.test/password123 THEN /dashboard shows the header with alice@acme.test and a logout control; clicking logout returns to /login and /dashboard no longer renders (redirects to /login). Acceptance: header email matches the account; after logout, reloading /dashboard redirects to /login.

**S2 — Shell and navigation.** GIVEN alice on /dashboard WHEN the header renders THEN it contains Dashboard and Admin links and the signed-in email. Admin link opens /admin. Acceptance: both links navigate; the page header is identical on /dashboard and /admin (same shell).

**S3 — Invoice search/filter (admin or member).** GIVEN /dashboard with invoice rows WHEN typing a customer fragment in the search box and pressing Apply THEN the table shows only matching customers and a Clear link appears. Same for the status dropdown (e.g. open). Clear returns the full list. Acceptance: filtered URL is /dashboard?q=...&status=... and survives reload; Clear removes the params; Next page under a filter keeps the filter applied.

**S4 — Invoice pagination.** GIVEN more than one page of invoices WHEN Next page is clicked THEN the cursor (after=...) appears in the URL and the next rows load. Acceptance: Back returns to the previous page; the page is addressable.

**S5 — Cross-org isolation.** GIVEN bob@globex.test signed in THEN the dashboard shows only Globex invoices, never Acme's. carol@acme.test sees Acme invoices but cannot reach /admin (redirected). Acceptance: no row from another org appears for any role; the admin API returns 403 for member and viewer.

**S6 — Admin copilot settings.** GIVEN alice on /admin WHEN toggling demoMode ON and saving THEN the settings persist across reload. Acceptance: refresh keeps the toggle; GET /api/admin/copilot-settings returns the saved values; bob/carol get 403.

**S7 — Copilot demo mode.** GIVEN alice on /dashboard with demoMode ON and guardsEnabled OFF WHEN asking the copilot "how much revenue did we collect?" THEN the panel streams a deterministic answer computed from real data and shows the Demo answer badge. Acceptance: two identical questions give identical answers; the answer cites real rows; no API key is needed.

**S8 — Copilot live mode (requires a model key).** GIVEN demoMode OFF and a provider configured in /admin with an env var holding the key WHEN asking a question THEN the panel streams a live answer with citations, or shows a budget/abstention message with a retry link. Acceptance: budget refusals (guardsEnabled ON) render as friendly messages, not raw errors.

**S9 — Determinism without a key.** GIVEN demoMode ON and NO provider configured WHEN asking any question THEN the answer is always the demo answer, never an error. Acceptance: the runbook demo path works in a clean clone with no secrets (this is the presentation fallback).

**S10 — Data freshness.** GIVEN /dashboard WHEN the freshness badge renders THEN it shows when the last ingestion completed; if stale, the page still renders and the badge says so. Acceptance: no crash on a fresh DB with no runs.

## Flag combinations

| demoMode | guardsEnabled | providers | Expected copilot behaviour |
| --- | --- | --- | --- |
| ON | any | any | deterministic demo answer, Demo badge, no network LLM call |
| OFF | OFF | configured | live answer, no budget refusal |
| OFF | ON | configured | live answer; per-user/org windows and daily caps enforced (429/402 → friendly message) |
| OFF | ON | none | refusal message (no provider) — never an error page |

E2E coverage lives in tests/stage4-auth.spec.ts, tests/stage5-tools.spec.ts, tests/copilot-demo-mode.spec.ts, tests/agent-token-cap.spec.ts.
<!-- proof: tests/stage4-auth.spec.ts -->
<!-- proof: tests/copilot-demo-mode.spec.ts -->
<!-- proof: tests/agent-token-cap.spec.ts -->
<!-- proof: src/features/admin/copilot-settings.ts -->
<!-- proof: docs/ACCOUNTS.md -->

