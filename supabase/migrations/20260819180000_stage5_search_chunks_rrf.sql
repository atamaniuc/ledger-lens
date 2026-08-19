-- Hybrid retrieval: one function, two halves, fused by rank.
--
-- ADR 0008. The vector half finds text that means the same thing; the lexical
-- half finds the exact identifier a person actually typed (INV-2043, a
-- customer name, a currency code) — which is what a 384-dimension model is
-- worst at. Reciprocal Rank Fusion combines them because it combines *ranks*
-- and needs no normalisation between a cosine distance and a ts_rank, two
-- numbers on unrelated scales whose relative weight would otherwise be a
-- constant nobody could justify.
--
-- SECURITY INVOKER is the whole authorization story. The function holds no
-- privilege of its own, so the caller's RLS policy on `chunks` decides what
-- either half can see — the same decision ADR 0007 made for the dashboard,
-- and the reason "org A cannot reach org B's chunks through the agent" is
-- testable rather than asserted. A SECURITY DEFINER variant taking an org_id
-- parameter would make the caller's own input the tenant selector, which is
-- the CRITICAL defect Stage 2's review already found once in the webhook.

create or replace function search_chunks(
  query_embedding extensions.vector(384),
  query_text text,
  match_limit int default 5
)
returns table (
  chunk_id bigint,
  source_kind text,
  document_id uuid,
  document_title text,
  invoice_id uuid,
  content text,
  vector_rank int,
  lexical_rank int,
  rrf_score double precision
)
language sql
stable
security invoker
-- Empty search_path, so every name below is qualified and none of them can be
-- captured by a caller's own schema.
set search_path = ''
as $$
  with
  -- Each half is deliberately deeper than match_limit: fusion only has
  -- something to do when the two lists disagree, and a list cut to 5 rarely
  -- disagrees with anything.
  candidate_depth as (
    select greatest(coalesce(match_limit, 5) * 4, 20) as depth
  ),
  vector_hits as (
    select
      c.id,
      row_number() over (
        order by c.embedding operator(extensions.<=>) query_embedding
      )::int as rank
    from public.chunks c
    order by c.embedding operator(extensions.<=>) query_embedding
    limit (select depth from candidate_depth)
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
      v.rank as vector_rank,
      l.rank as lexical_rank,
      -- k = 60 is RRF's published default. It is left alone precisely
      -- because leaving it alone is the point: no tuning constant to defend.
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
    c.content,
    f.vector_rank,
    f.lexical_rank,
    f.rrf_score
  from fused f
  join public.chunks c on c.id = f.id
  left join public.documents d on d.id = c.document_id
  order by f.rrf_score desc, c.id
  limit coalesce(match_limit, 5);
$$;

comment on function search_chunks(extensions.vector, text, int) is
  'Hybrid retrieval over chunks: vector + full-text, fused by Reciprocal Rank Fusion (k=60). SECURITY INVOKER — RLS on chunks is the only authorization (ADR 0008).';

-- Nothing auto-exposes a new function, and only the signed-in user needs it.
-- The indexer never searches, so service_role is not granted execute either.
revoke all on function search_chunks(extensions.vector, text, int) from public, anon, authenticated, service_role;
grant execute on function search_chunks(extensions.vector, text, int) to authenticated;
