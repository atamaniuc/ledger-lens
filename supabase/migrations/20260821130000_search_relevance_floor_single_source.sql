-- D-31: one source for min_similarity — the app constant, not this function.
--
-- The floor used to live in two places that "deliberately" disagreed: the SQL
-- function's default said 0.78 while src/features/rag/search.ts passed 0.80
-- explicitly, on the theory that every caller passes it anyway. That is
-- exactly the divergence that survives until someone calls the RPC by hand —
-- a hand-written call gets a floor that is not the floor the app uses, and
-- nothing fails.
--
-- This migration removes the SQL defaults (min_similarity's 0.78 and, with
-- it, match_limit's 5 — Postgres refuses a non-default parameter after a
-- defaulted one) and the internal coalesce fallback that mirrored the floor.
-- The app passes both arguments explicitly (see searchChunks in
-- src/features/rag/search.ts), so nothing in the request path changes; only a
-- hand-written call that omits an argument changes, and it changes from
-- silently searching at a different floor to failing loudly.
--
-- DEFAULT_MIN_SIMILARITY in src/features/rag/search.ts is now the single
-- source, and the unit test (src/features/rag/search.test.ts) greps every
-- migration at or after this one for a re-introduced default or fallback and
-- fails the suite if one ever comes back.
--
-- The signature stays search_chunks(vector, text, int, double precision):
-- Postgres identifies overloads by argument types, not by which parameters
-- have defaults, so the grants below keep matching the same function. The
-- body is the 20260819210000 version (invoice external id included so a
-- citation made from a search result can be verified) minus the defaults.

drop function if exists search_chunks(extensions.vector, text, int);
drop function if exists search_chunks(extensions.vector, text, int, double precision);

create function search_chunks(
  query_embedding extensions.vector(384),
  query_text text,
  match_limit int,
  min_similarity double precision
)
returns table (
  chunk_id bigint,
  source_kind text,
  document_id uuid,
  document_title text,
  invoice_id uuid,
  invoice_external_id text,
  content text,
  similarity double precision,
  vector_rank int,
  lexical_rank int,
  rrf_score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with
  candidate_depth as (
    select greatest(coalesce(match_limit, 5) * 4, 20) as depth
  ),
  -- Ordered by the index first, filtered second: the HNSW scan stays a
  -- nearest-neighbour scan, and the floor is applied to what it returns.
  vector_candidates as (
    select c.id, c.embedding operator(extensions.<=>) query_embedding as distance
    from public.chunks c
    order by c.embedding operator(extensions.<=>) query_embedding
    limit (select depth from candidate_depth)
  ),
  vector_hits as (
    select
      v.id,
      (1 - v.distance)::double precision as similarity,
      row_number() over (order by v.distance)::int as rank
    from vector_candidates v
    -- No fallback on the floor: min_similarity is required, so the value that
    -- applies is the one the caller supplied (DEFAULT_MIN_SIMILARITY in the
    -- app). The coalesce on match_limit is defensive only; match_limit is
    -- required too.
    where 1 - v.distance >= min_similarity
  ),
  lexical_hits as (
    select
      c.id,
      row_number() over (
        order by pg_catalog.ts_rank(c.content_tsv, q.query) desc, c.id
      )::int as rank
    from public.chunks c
    cross join pg_catalog.websearch_to_tsquery('english', coalesce(query_text, '')) as q(query)
    where c.content_tsv @@ q.query
    order by pg_catalog.ts_rank(c.content_tsv, q.query) desc, c.id
    limit (select depth from candidate_depth)
  ),
  fused as (
    select
      coalesce(v.id, l.id) as id,
      v.similarity,
      v.rank as vector_rank,
      l.rank as lexical_rank,
      coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + l.rank), 0.0) as rrf_score
    from vector_hits v
    full outer join lexical_hits l on l.id = v.id
  )
  select
    c.id as chunk_id,
    c.source_kind,
    c.document_id,
    d.title as document_title,
    c.invoice_id,
    i.external_id as invoice_external_id,
    c.content,
    f.similarity,
    f.vector_rank,
    f.lexical_rank,
    f.rrf_score
  from fused f
  join public.chunks c on c.id = f.id
  left join public.documents d on d.id = c.document_id
  left join public.invoices i on i.id = c.invoice_id
  order by f.rrf_score desc, c.id
  limit coalesce(match_limit, 5);
$$;

comment on function search_chunks(extensions.vector, text, int, double precision) is
  'Hybrid retrieval over chunks: vector (with a relevance floor the app supplies — DEFAULT_MIN_SIMILARITY in src/features/rag/search.ts is the single source; there is no SQL default) + full-text, fused by Reciprocal Rank Fusion (k=60). Returns the invoice external id so a citation made from a search result can be verified. SECURITY INVOKER — RLS on chunks is the only authorization (ADR 0008).';

revoke all on function search_chunks(extensions.vector, text, int, double precision)
  from public, anon, authenticated, service_role;
grant execute on function search_chunks(extensions.vector, text, int, double precision)
  to authenticated;
