# LedgerLens — Database Schema

Full Postgres schema for LedgerLens, self-contained in this repository (not
dependent on personal, untracked notes). Target: Postgres via Supabase, with
`pgvector` for embeddings. See [`docs/PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)
for the entity-relationship diagram and how these tables fit into the
pipeline; see [`.claude/PRD.md`](../.claude/PRD.md) for the requirements each
table serves.

Apply as a Supabase migration (`supabase migration new init_schema`, paste
below, `supabase db push`) once the project is scaffolded — see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

Before changing anything here: load the `supabase:supabase-postgres-best-practices`
skill first, per `CLAUDE.md`'s Domain-Specific Rules — applies even to a
one-column change.

---

## Extensions

```sql
create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto;
```

Both live in the `extensions` schema, which is where Supabase puts them and
what a `search_path`-pinned function has to qualify against — hence
`extensions.vector(384)` and `extensions.vector_cosine_ops` below.

---

## Tenants and users

```sql
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table memberships (
  user_id uuid not null,
  org_id  uuid not null references orgs(id),
  role    text not null check (role in ('admin','member','viewer')),
  primary key (user_id, org_id)
);
```

---

## Pipeline runs

```sql
create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  source       text not null,
  -- 'webhook' is distinct from 'incremental' on purpose: the polling path
  -- resumes from the newest succeeded *incremental* run's cursor_to, and a
  -- cursorless webhook run counted as one would reset it to the beginning.
  kind         text not null
               check (kind in ('incremental','full','backfill','webhook')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
               check (status in ('running','succeeded','failed')),
  cursor_from  text,
  cursor_to    text,
  rows_read    int not null default 0,
  rows_written int not null default 0,
  rows_quarantined int not null default 0,
  -- Records that were already ingested. Without this column the identity
  -- rows_read = written + quarantined + deduplicated doesn't hold, and
  -- "every raw record ends up somewhere" can't be checked from this table —
  -- which is exactly how a silent-drop bug stayed invisible.
  rows_deduplicated int not null default 0,
  correlation_id text,
  error        text
);
```

---

## Raw layer — nothing is discarded

```sql
create table raw_events (
  id            bigserial primary key,
  org_id        uuid not null references orgs(id),
  source        text not null,
  external_id   text not null,
  event_version text not null default '1',
  payload       jsonb not null,
  -- hash is computed application-side on insert: a generated column with
  -- digest() is finicky about the IMMUTABLE requirement — not worth the time
  payload_hash  text not null,
  run_id        uuid not null references pipeline_runs(id),
  ingested_at   timestamptz not null default now(),
  -- THIS is the idempotency guarantee — and org_id is part of it.
  --
  -- An earlier version of this schema omitted org_id here, which shipped
  -- and had to be corrected in a follow-up migration. The failure was
  -- silent and total: a second tenant ingesting the same external_id from
  -- the same source conflicted with the first tenant's row, ON CONFLICT DO
  -- NOTHING discarded it, and the run reported success with an empty
  -- invoices table. Note the asymmetry that gave it away — `invoices` was
  -- already `unique (org_id, external_id)`; nothing else in this schema
  -- treats external_id as globally unique.
  unique (org_id, source, external_id, event_version)
);
```

---

## Staging / marts — typed facts

```sql
create table invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  external_id  text not null,
  customer     text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency     char(3) not null,
  status       text not null check (status in ('draft','open','paid','void')),
  issued_at    date not null,
  paid_at      date,
  -- lineage
  raw_event_id bigint not null references raw_events(id),
  run_id       uuid not null references pipeline_runs(id),
  transformed_at timestamptz not null default now(),
  pipeline_version text not null,
  unique (org_id, external_id)
);
```

---

## Quarantine — bad records are never lost or block the load

```sql
create table quarantine (
  id          bigserial primary key,
  org_id      uuid not null references orgs(id),
  raw_event_id bigint references raw_events(id),
  run_id      uuid not null references pipeline_runs(id),
  reason      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
```

---

## Data quality

```sql
create table data_quality_results (
  id         bigserial primary key,
  org_id     uuid not null references orgs(id),
  run_id     uuid references pipeline_runs(id),
  check_name text not null,       -- freshness | volume | uniqueness | reconciliation
  status     text not null check (status in ('pass','warn','fail')),
  observed   numeric,
  expected   numeric,
  delta      numeric,
  details    jsonb,
  created_at timestamptz not null default now()
);
```

---

## Documents and RAG

Shipped in `20260819160000_stage5_documents_and_chunks.sql`. Architecture is
[ADR 0008](../.claude/adr/0008-retrieval-embeds-in-the-edge-runtime-with-gte-small-hybrid-search-is-one-security-invoker-function.md):
384-dimension `gte-small` embeddings computed by the Edge Runtime, and one
`SECURITY INVOKER` search function fusing a vector half with a lexical half.

```sql
create table documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  title        text not null,
  kind         text not null
               check (kind in ('payment_terms','dispute_note','memo','contract','policy')),
  body         text not null,
  content_hash text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, title)
);
create index documents_org_id_idx on documents (org_id);

create table chunks (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references orgs(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  invoice_id  uuid references invoices(id) on delete cascade,
  source_kind text generated always as (
                case when document_id is not null then 'document' else 'invoice' end
              ) stored,
  chunk_no    int not null check (chunk_no >= 0),
  content     text not null,
  content_hash text not null,
  embedding   extensions.vector(384) not null,
  embedding_model text not null,
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint chunks_exactly_one_source check (num_nonnulls(document_id, invoice_id) = 1)
);

alter table chunks
  add constraint chunks_document_chunk_no_key unique (document_id, chunk_no);
alter table chunks
  add constraint chunks_invoice_chunk_no_key unique (invoice_id, chunk_no);

create index chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding extensions.vector_cosine_ops);
create index chunks_content_tsv_idx on chunks using gin (content_tsv);
```

Three things here are decisions rather than defaults.

**The corpus has two halves and one table.** `documents` holds text that
exists nowhere else — payment terms, dispute notes, month-end memos.
Invoice rows are the other half and are *not* copied into `documents`; they
are chunked straight from `invoices`, so a figure has one home rather than a
copy that can drift from it.

**The parent is a foreign key, not a polymorphic id.** Two nullable columns
with a `num_nonnulls(...) = 1` check buy referential integrity and
`ON DELETE CASCADE`, which a `(source_kind, source_id)` pair cannot have
against two tables at once. `source_kind` survives as a *generated* column,
so the discriminator callers read can never disagree with the columns it
comes from. The upsert keys are plain unique constraints, not the partial
indexes `20260819160000` first created: NULLs are distinct in a unique index,
so an invoice chunk (null `document_id`) never conflicts with another one
anyway, and the predicate only made the key un-inferable by `ON CONFLICT`
(`20260819170000` records that in full).

**`embedding_model` is stored per row.** Changing the embedding model
changes `extensions.vector(384)` — a column type, so a migration and a full
re-embed. This column is what makes a half-migrated corpus a query rather
than a memory.

**Retrieval has a measured relevance floor.** `search_chunks(...)` takes a
`min_similarity` parameter defaulting to 0.78, applied to the vector half
only. Without it "empty retrieval" is a state a nearest-neighbour search never
reaches — it always has nearest neighbours — so the agent's abstention (US-06)
could never fire, and an unanswerable question came back with five confident,
irrelevant chunks. Migration `20260819200000` carries the measurements the
number comes from. The lexical half is not filtered: a full-text match is a
term the user actually typed, which is evidence on its own terms.

`chunks` is the one table in this schema where `service_role` holds
`DELETE`. Everything else is append-only because it records what arrived;
`chunks` is a derived index of *current* text, and a document that loses a
paragraph has to lose its tail chunks or retrieval keeps answering from text
the document no longer contains.

---

## Audit — append-only

Shipped in `20260819190000_stage5_llm_calls_and_audit_log.sql`, alongside
`llm_calls` below. Architecture is
[ADR 0009](../.claude/adr/0009-the-agent-executes-under-the-users-jwt-with-four-read-only-tools-and-no-send-capability.md).

```sql
create table audit_log (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references orgs(id) on delete cascade,
  correlation_id text not null,
  actor_type     text not null check (actor_type in ('user','service','agent')),
  actor_id       text not null,
  on_behalf_of   uuid,
  action         text not null,
  entity         text,
  entity_id      text,
  details        jsonb,
  created_at     timestamptz not null default now(),
  constraint audit_log_agent_names_its_principal
    check (actor_type <> 'agent' or on_behalf_of is not null)
);
```

**Nobody holds INSERT on this table.** `authenticated` has `SELECT` and
nothing else, and there is no INSERT policy — RLS denies what no policy
allows. Rows arrive only through `log_agent_action(...)`, a `SECURITY
DEFINER` function that establishes the caller with `auth.uid()`, checks
membership itself, and stamps `actor_type` and `on_behalf_of` rather than
accepting them.

That is the whole point. The agent runs *as the user* (ADR 0009), so a policy
permissive enough for it to insert its own audit rows would be permissive
enough for that user to forge them with the anon key and curl. An audit log
its own subject can write to is not an audit log.

---

## LLM call traces

```sql
create table llm_calls (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references orgs(id) on delete cascade,
  correlation_id text not null,
  step_no        int not null default 0 check (step_no >= 0),
  model          text not null,
  prompt_version text not null,
  input_tokens   int check (input_tokens >= 0),
  output_tokens  int check (output_tokens >= 0),
  cost_cents     numeric(12,4) check (cost_cents >= 0),
  latency_ms     int check (latency_ms >= 0),
  tool_name      text,
  tool_args      jsonb,
  retrieved_chunk_ids bigint[],
  outcome        text not null
                 check (outcome in ('ok','abstained','step_cap','timeout','token_ceiling','error')),
  created_at     timestamptz not null default now()
);
```

Written the same way, through `log_llm_call(...)`, with the same lack of an
INSERT grant.

`cost_cents` is computed at write time from the versioned price table in
`lib/agent/pricing.ts`, so a historical row keeps the price actually paid and
a later price change cannot rewrite last month's numbers.

`outcome` is not decoration either: a turn that ran out of steps, wall clock
or tokens has to say which, because the alternative is a truncated answer
that reads like a complete one.

Every row of one request's chain — both tables — shares one
`correlation_id`, per `CLAUDE.md`'s project-wide logging contract.

---

## Job queue

```sql
create table jobs (
  id         bigserial primary key,
  org_id     uuid not null references orgs(id),
  kind       text not null,
  payload    jsonb not null,
  status     text not null default 'pending',
  attempts   int not null default 0,
  run_after  timestamptz not null default now(),
  locked_at  timestamptz,
  last_error text
);
create index on jobs (status, run_after);
```

Consumed with `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent-safe
polling. See the "Background jobs, event-driven" row in `.claude/PRD.md`'s
overview for why this is paired with a webhook path rather than relied on
alone.

---

## Row-Level Security

Worked example on these three — **every** org-scoped table in this schema
needs the same treatment before that table is queried by anything other
than a migration (`CLAUDE.md`: *every table, RLS on* — not a suggestion).
That means `raw_events`, `pipeline_runs`, `quarantine`,
`data_quality_results`, `documents`, `llm_calls`, and `jobs` too, each
enabled and policied in the same migration that creates it — not
deferred to a later cleanup pass. Flagged explicitly here because a
review pass caught this doc reading as if the three-table example were
sufficient coverage; it never was.

```sql
alter table invoices enable row level security;
alter table chunks   enable row level security;
alter table audit_log enable row level security;

create policy "read own org invoices" on invoices
for select to authenticated
using (
  org_id in (
    select org_id from memberships
    where user_id = (select auth.uid())
  )
);

create policy "read own org chunks" on chunks
for select to authenticated
using (
  org_id in (
    select org_id from memberships
    where user_id = (select auth.uid())
  )
);
```

`(select auth.uid())` (wrapped in a subquery, not called bare) is the
Supabase-documented RLS performance optimization — the planner can cache it
once per statement instead of re-evaluating per row.

**Verification (Definition of Done item 4):** query as a user who is *not*
a member of the target `org_id` and confirm the result set is empty — not
an error, not another org's masked data, empty.

---

## Write path: `ingest_raw_event`

Both ingestion entrypoints (the polling route and the `provider-webhook`
Edge Function) write through one `plpgsql` function rather than issuing the
`raw_events` insert and its `invoices`/`quarantine` counterpart as separate
statements. Full definition in
`supabase/migrations/20260817143416_stage2_pin_ingest_raw_event_search_path.sql`.

Why it exists: as two round-trips, a failure between them left a
`raw_events` row with no downstream row. Since idempotency was keyed on
"does a raw event exist", the retry that should have healed that gap was
the thing that permanently closed it — and reported success. Inside one
function the two writes are one transaction, so a failure rolls back both
and no orphan can be created. The conflict path also checks for a
downstream row, so an orphan left by an earlier run gets completed instead
of skipped.

Validation stays in TypeScript (`lib/ingestion/transform.ts`, shared
verbatim by both paths per ADR 0002) — the function receives an
already-decided outcome and does not reimplement the Zod schema in SQL.

`reap_abandoned_runs` (same migration series) closes out `pipeline_runs`
rows stuck at `status='running'` because a serverless invocation was killed
before it could close its own row. Called at the start of each run, so
staleness is bounded by run frequency without deploying a scheduler.

Both functions are `SECURITY INVOKER` with `search_path` pinned to `''`,
and `EXECUTE` is revoked from `public`/`anon`/`authenticated` — only the
pipeline's service-role client calls them.

---

## Reconciliation source of truth

The mock provider's `/api/mock-provider/summary` endpoint is the
independent total that `data_quality_results`' `reconciliation` check
compares `sum(invoices.amount_cents)` against, per org. It is deliberately
computed from a source *other than* `raw_events`/`invoices` — reconciling
against your own derived data proves nothing, since duplicated rows are
perfectly internally consistent with themselves.
