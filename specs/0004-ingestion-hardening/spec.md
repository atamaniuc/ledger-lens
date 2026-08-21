# 0004 — Ingestion Hardening

**Status:** proposed · **Lane:** W2-E · **Debt closed:** D-15, D-16, D-17, D-19

## Why

- The webhook trusts a static header secret, so a replay passes (D-19).
- `futureDates` chaos flows through as a valid invoice (D-15) and chaos flags are ON by default (D-16).
- The 45s ingest budget is hardcoded and exceeds some serverless limits (D-17).

## User stories

**US-01** — As an operator, I want the webhook authenticated by HMAC + timestamp + nonce, so a replayed or forged request fails.
**US-02** — As a data consumer, I want future-dated invoices quarantined, so impossible dates never enter `invoices`.
**US-03** — As a platform owner, I want chaos off outside dev/test, so a production run is a real run.
**US-04** — As a deployer, I want the ingest budget from env, so it fits the platform's serverless limits.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a webhook request with a valid signature WHEN the same request is delivered twice THEN the second is rejected as a replay (test: `tests/webhook-hmac.spec.ts`, D-19)
**AC-02** — GIVEN a request with a bad/absent signature, expired timestamp or reused nonce WHEN it hits the webhook THEN the function returns 401 and comparison is timing-safe (`crypto.timingSafeEqual`) (test: `tests/webhook-hmac.spec.ts`, D-19)
**AC-03** — GIVEN an invoice with `issued_at` in the future WHEN it is transformed THEN it lands in `quarantine` with a reason, never in `invoices` (test: `tests/future-dates.spec.ts`, D-15)
**AC-04** — GIVEN `APP_ENV=production` WHEN the mock provider configures chaos THEN every chaos flag is OFF (test: `tests/chaos-prod-config.spec.ts`, D-16)
**AC-05** — GIVEN a platform with a different serverless limit WHEN `INGEST_BUDGET_MS` is set in env THEN the run respects it; no hardcoded 45s literal in the route (grep: no `45000` in app/api/ingestion, D-17)
**AC-06** — GIVEN the ingest route WHEN it starts THEN the budget comes from `config.ts`, documented in the RUNBOOK (D-17)

## Invariants

- Chaos flags are never softened to make a run pass.
- Webhook auth is HMAC + timestamp + nonce + timing-safe comparison; static header secrets are gone.
- `futureDates` → quarantine, with the same rows_read/written/quarantined accounting.
- Budgets come from env, never literals.

## Out of scope

- Scheduling and locks (spec 0003).
- RBAC/budget for the chat route (spec 0002).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W2-E).
