-- Stage 5 (RAG & Agent) corpus tables: documents and chunks.
--
-- Architecture is ADR 0008: embeddings are 384-dimension gte-small vectors
-- computed by the Edge Runtime, hybrid search is one SECURITY INVOKER
-- function (Batch E) fusing a vector half and a lexical half. This
-- migration creates only what that function reads.
--
-- See docs/DATABASE_SCHEMA.md for the documented schema.

create extension if not exists vector with schema extensions;

-- Documents are corpus text that exists nowhere else in the database:
-- payment terms, dispute notes, month-end memos. Invoice rows are the
-- other half of the corpus and are not copied here — they are chunked
-- directly from `invoices` (see `chunks.invoice_id` below), so there is
-- one row per fact rather than a synchronised duplicate.
create table documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  title        text not null,
  kind         text not null
               check (kind in ('payment_terms','dispute_note','memo','contract','policy')),
  body         text not null,
  -- Hash of `body`. The indexer (Batch D) re-embeds a document only when
  -- this changes, which is what makes `task index` idempotent.
  content_hash text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, title)
);
create index documents_org_id_idx on documents (org_id);

-- One row per embedded chunk, for both corpus halves.
--
-- The parent is a real foreign key rather than a polymorphic
-- (source_kind, source_id) pair: two nullable columns with exactly one
-- populated buys referential integrity and ON DELETE CASCADE, which a
-- polymorphic id cannot have against two tables at once. `source_kind`
-- survives as a generated column so callers still get the single
-- discriminator ADR 0008 describes, with no way for it to disagree with
-- the columns it is derived from.
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
  -- Not decoration: this is how a corpus half-migrated to another model is
  -- found by a query instead of by memory (ADR 0008, Consequences).
  embedding_model text not null,
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint chunks_exactly_one_source check (num_nonnulls(document_id, invoice_id) = 1)
);

-- Re-indexing upserts on these, so they are unique indexes rather than
-- constraints: ON CONFLICT can infer a partial index, and a two-column
-- constraint cannot express "only when this parent is the populated one".
create unique index chunks_document_chunk_no_key
  on chunks (document_id, chunk_no) where document_id is not null;
create unique index chunks_invoice_chunk_no_key
  on chunks (invoice_id, chunk_no) where invoice_id is not null;

create index chunks_org_id_idx on chunks (org_id);
create index chunks_document_id_idx on chunks (document_id);
create index chunks_invoice_id_idx on chunks (invoice_id);

-- The two halves of the hybrid search. Cosine, because gte-small's output
-- is not normalised and cosine is what the fusion in Batch E orders by.
create index chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding extensions.vector_cosine_ops);
create index chunks_content_tsv_idx on chunks using gin (content_tsv);

-- RLS — enabled in the same migration that creates the table, per
-- CLAUDE.md. The policy shape matches Stage 2's: auth.uid() wrapped in a
-- SELECT so it is evaluated once per query rather than once per row.
alter table documents enable row level security;
alter table chunks enable row level security;

create policy "read own org documents" on documents
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

create policy "read own org chunks" on chunks
for select to authenticated
using (
  org_id in (select org_id from memberships where user_id = (select auth.uid()))
);

-- Grants, following 20260818094500_stage2_explicit_data_api_grants.sql:
-- revoke the three Data API roles to nothing, then grant back only the
-- verbs each actually uses. A grant is permission to attempt a query; the
-- policies above still decide which rows come back.
revoke all on table public.documents, public.chunks
  from anon, authenticated, service_role;

-- anon gets nothing back: no policy exists for it, so a grant would widen
-- the surface without enabling anything.

grant select on table public.documents, public.chunks to authenticated;

-- The indexer runs as service_role (no end user behind `task index`). It
-- reads documents and invoices, and writes chunks.
grant select on table public.documents to service_role;
grant select, insert, update, delete on table public.chunks to service_role;

-- DELETE is granted here and nowhere else in this schema. raw_events,
-- invoices and quarantine are append-only because they are the audit
-- record of what arrived; chunks are a derived index of current text. A
-- document that loses a paragraph must lose its tail chunks, or retrieval
-- keeps answering from text the document no longer contains — a stale
-- corpus is a worse failure than a re-runnable delete.
