-- `search_chunks` now returns the invoice's external id alongside its uuid.
--
-- Found in the reviewer pass, and it broke a safety claim rather than a
-- convenience. Invoice-derived chunks read "Invoice inv_00007 for customer …"
-- (lib/rag/chunk.ts, `renderInvoice`), and the system prompt tells the agent
-- to cite invoices as `[invoice:<external_id>]`. But the tool result carried
-- only `invoice_id`, a uuid, so the external id the model correctly read out
-- of the chunk text was never recorded as retrieved evidence. A true citation
-- from a search result therefore came back `verified: false`, and the
-- dashboard put its "cites something that was not in anything the copilot
-- read" warning on top of a correct answer.
--
-- A warning that fires on correct answers is worse than no warning: it trains
-- the reader to ignore the one signal that matters.
--
-- The join is `left`, because a document-derived chunk has no invoice, and it
-- goes through the same RLS as everything else in this SECURITY INVOKER
-- function — a chunk the caller can read belongs to an org whose invoices the
-- caller can read.

drop function if exists search_chunks(extensions.vector, text, int, double precision);

create function search_chunks(
  query_embedding extensions.vector(384),
  query_text text,
  match_limit int default 5,
  min_similarity double precision default 0.78
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
    where 1 - v.distance >= coalesce(min_similarity, 0.78)
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
  'Hybrid retrieval over chunks: vector (with a measured relevance floor) + full-text, fused by Reciprocal Rank Fusion (k=60). Returns the invoice external id so a citation made from a search result can be verified. SECURITY INVOKER — RLS on chunks is the only authorization (ADR 0008).';

revoke all on function search_chunks(extensions.vector, text, int, double precision)
  from public, anon, authenticated, service_role;
grant execute on function search_chunks(extensions.vector, text, int, double precision)
  to authenticated;
