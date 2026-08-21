# 0005: Data quality checks in one Postgres function; reconciliation accounts for quarantined value

Status: Accepted

## Context

Stage 3 runs four checks — freshness, volume, uniqueness, reconciliation — recording a `pass`/`warn`/`fail` row per `run_id` in `data_quality_results`. Two questions had real forks.

**Where the checks execute.** Three are aggregate queries. The fourth compares against the provider's `/summary` endpoint, and Postgres does not make outbound HTTP without an extension nothing else justifies. Something has to bridge.

**What reconciliation compares.** The obvious answer is wrong. `sum(invoices.amount_cents)` vs `summary.total_amount_cents` on the seeded set: provider 52,417,661; sum 47,942,632; drift **−4,475,029 (−8.54%)** — on a pipeline working exactly as designed. The missing value is the twenty records the provider deliberately corrupts (null `customer`) that the pipeline correctly quarantines. Loosening the threshold to absorb it makes the check meaningless: 8.54% tolerance hides a real loss.

## Decision

**One function, `public.run_data_quality_checks(p_org_id, p_run_id, p_provider_total_cents, p_provider_invoice_count)`, computes and inserts all four results in a single transaction.** The caller does the HTTP request to `/summary` first and passes the provider's numbers as parameters; the function does no I/O.

**Reconciliation compares the provider total against *accounted* value**: `sum(invoices.amount_cents)` plus, for quarantine rows with a `raw_event_id`, `sum(round((raw_events.payload->>'amount')::numeric * 100))`. Same dataset: 47,942,632 + 4,475,029 = 52,417,661 → **drift 0**. Quarantine rows with null `raw_event_id` (atomic write rolled back; payload unrecoverable) count as `unaccounted_rows` and force `fail` regardless of arithmetic — the records whose value genuinely cannot be located. Statuses: drift 0 with no unaccounted → `pass`; within ±0.5% → `warn`; anything else or any unaccounted row → `fail`.

## Consequences

- The check is meaningful on healthy data: zero is the expected value, so any nonzero drift is signal — *no value disappears silently*.
- All four results appear together or not at all (a partial set would be indistinguishable from a run where a check was never configured). One round-trip instead of five.
- Reconciliation depends on `raw_events.payload` retaining a readable `amount`; a renamed field turns the check red — arguably correct, but it points at reconciliation, not the schema change.
- Four responsibilities in one function; accepted for atomicity.
- `uniqueness` is tautological today (`unique (org_id, external_id)`); kept because the PRD specifies it (US-03) — a constraint removed by a later migration must not silently take its verification with it. Its `details` additionally report non-tautological duplicates on `(customer, amount_cents, issued_at)`.

## Alternatives considered

- **Four separate functions:** results would no longer be atomic — an error in the third call leaves two rows for a `run_id` that never gets the others, indistinguishable from a partially-configured run.
- **All four in TypeScript in the route:** separate round-trips, no shared transaction; uniqueness would mean pulling every `(org_id, external_id)` pair across the wire.
- **`pg_net`/`http` so the function fetches `/summary` itself:** a large dependency (outbound HTTP from the DB) for one parameter the caller already has, and a network call inside the transaction.
- **Loosen the threshold to ±10%:** makes the check pass without making it true — a tolerance that absorbs the quarantine rate is wide enough to absorb a real loss.
- **Exclude quarantined records from the comparison:** the provider cannot tell us which records we quarantined, and it silently defines away the question the check is for.
