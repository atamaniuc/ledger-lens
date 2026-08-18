# 0005: data quality checks in one Postgres function, reconciliation accounts for quarantined value

Status: Accepted

## Context

Stage 3 has to run four checks — freshness, volume, uniqueness,
reconciliation — and record a `pass`/`warn`/`fail` row per `run_id` in
`data_quality_results`. Two questions had real forks in them; the rest
followed from the PRD.

**Where the checks execute.** Three of the four are pure aggregate queries
over tables that already exist. The fourth is not: reconciliation compares
against the mock provider's own `/summary` endpoint, and Postgres does not
make outbound HTTP requests without an extension this project has no other
reason to install. So the checks cannot all live in one place by default —
something has to bridge.

**What reconciliation actually compares.** This is the question that
mattered, and the obvious answer is wrong. The natural reading of "compare
our total against the provider's total" is
`sum(invoices.amount_cents)` versus `summary.total_amount_cents`. Measured
against the seeded local dataset, that comparison reports:

| | cents |
|---|---|
| provider `/summary` | 52,417,661 |
| `sum(invoices.amount_cents)` | 47,942,632 |
| drift | **−4,475,029 (−8.54%)** |

An 8.54% shortfall on a pipeline that is working exactly as designed. The
missing value is the twenty records the provider deliberately corrupts
(null `customer`) and the pipeline correctly quarantines. A check that
fails on healthy data fails the PRD's own counter-metric — "no check should
produce false positives on a healthy run" — and, worse, would train its
reader to ignore it.

The temptation is to loosen the threshold until the healthy case passes.
That would make the check meaningless: an 8.54% tolerance is wide enough to
hide a real loss.

## Decision

**One Postgres function, `public.run_data_quality_checks(p_org_id, p_run_id,
p_provider_total_cents, p_provider_invoice_count)`, computes and inserts all
four results in a single transaction.** The caller performs the HTTP request
to `/summary` first and passes the provider's numbers in as parameters. The
function does no I/O of its own.

**Reconciliation compares the provider's total against *accounted* value,
not written value.** Every cent the provider reported must be traceable to
one of two places:

- an `invoices` row, or
- a `quarantine` row whose originating `raw_events.payload` carries the
  amount.

```
accounted = sum(invoices.amount_cents)
          + sum(round((raw_events.payload->>'amount')::numeric * 100))
              for quarantine rows that have a raw_event_id
```

Against the same dataset that produced the −8.54% above:

| | cents |
|---|---|
| provider `/summary` | 52,417,661 |
| invoiced | 47,942,632 |
| quarantined, recoverable from payload | 4,475,029 |
| **accounted** | **52,417,661** |
| **drift** | **0** |

Quarantine rows with a null `raw_event_id` — the case where the atomic
write rolled back and there is no payload to read — are counted separately
as `unaccounted_rows` and force the check to `fail` regardless of the
arithmetic. Those are the records whose value genuinely cannot be located,
which is exactly what this check exists to surface.

Statuses: drift of exactly 0 and no unaccounted rows → `pass`; drift within
±0.5% → `warn`; anything else, or any unaccounted row → `fail`.

## Consequences

Good:

- The check is meaningful on healthy data instead of tuned around it. Zero
  is the expected value, so any nonzero drift is a signal rather than
  noise, and the threshold does not have to be widened to accommodate
  normal operation.
- It states a property worth stating: *no value disappears silently*.
  Quarantining a record is a visible, accounted-for outcome; losing one is
  not. This is the counterpart at the value level to the row-level
  `rows_read = written + quarantined + deduplicated` invariant Stage 2
  established.
- All four results appear together or not at all. A partial set — three
  rows written and the fourth lost to an error — would be indistinguishable
  from a run where the fourth check was never configured.
- One round-trip from the route instead of five, and the aggregates run
  next to the data rather than pulling rows across the wire to sum them in
  TypeScript.

Bad, or at least accepted:

- Reconciliation now depends on `raw_events.payload` retaining a readable
  `amount`. A future upstream that changes that field's name would make
  quarantined value unrecoverable and turn the check red. That is arguably
  correct behaviour — the value really would be untraceable — but the
  failure would point at reconciliation rather than at the schema change
  that caused it.
- The function has four responsibilities rather than one. Splitting it into
  four would be cleaner by one measure and would give up the atomicity that
  motivated combining them.
- `uniqueness` is tautological today: `invoices` carries
  `unique (org_id, external_id)`, so the check cannot fail unless that
  constraint is dropped. It is kept because the PRD specifies it (US-03)
  and because a constraint that a later migration removes should not
  silently take its own verification with it. Its `details` additionally
  report a non-tautological observation — records identical on
  `(customer, amount_cents, issued_at)` under different `external_id`s,
  which idempotency by construction cannot catch — without affecting the
  status.

## Alternatives considered

**Four separate functions, one per check.** Cleaner separation, and each
could be called independently. Rejected because the results would no longer
be atomic: an error in the third call leaves two rows written for a `run_id`
that will never get the other two, and nothing distinguishes that from a
partially-configured run. The independence is also not worth much in
practice — nothing wants to run exactly one check.

**All four checks in TypeScript, in the route.** Would have avoided a
Postgres function entirely and kept the logic in the language the rest of
the pipeline is written in. Rejected on the same grounds as ADR 0004: the
aggregates would each be a separate round-trip, the four inserts would not
share a transaction, and the uniqueness check in particular would mean
pulling every `(org_id, external_id)` pair across the wire to count
duplicates that Postgres can count in place.

**`pg_net` or `http` extension so the function fetches `/summary` itself.**
Would make the function self-contained. Rejected as a large dependency —
outbound HTTP from the database, with its own failure and timeout
semantics — for one parameter that the caller already has in hand. It would
also put a network call inside the transaction that writes the results.

**Loosen the reconciliation threshold to ±10% so the naive comparison
passes.** Rejected outright: it is the option that makes the check pass
without making it true. A tolerance wide enough to absorb the quarantine
rate is wide enough to absorb a real loss of the same size, which is the
failure this stage exists to detect.

**Exclude quarantined records from the comparison entirely** — compare the
provider's total for non-quarantined records only. Rejected because it
requires the provider to tell us which records we quarantined, which it
cannot; and because it would silently define away the question the check is
for. If a record vanished before reaching quarantine, this framing would
report `pass`.
