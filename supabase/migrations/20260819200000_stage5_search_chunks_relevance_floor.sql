-- A relevance floor on the vector half of the search.
--
-- Found by writing US-06's abstention test: "empty retrieval" is a condition
-- a pure vector search essentially never reaches. Nearest-neighbour search
-- always has nearest neighbours, so a question about parental leave came back
-- with five confident chunks about invoices, and the mechanism that is
-- supposed to make the agent say "I don't have data on that" could never
-- fire. The bug was not in the agent; it was here.
--
-- The floor is measured, not guessed. Against this corpus with `gte-small`:
--
--   relevant   "what is our early settlement discount?"   0.844 0.843 0.820
--   relevant   "why was invoice INV-2043 disputed?"       0.897 0.876 0.876
--   relevant   "when do we write off an overdue invoice?" 0.892 0.883 0.847
--   unrelated  "what is our parental leave policy?"       0.753 0.753 0.751
--   unrelated  "how do I bake sourdough bread at home?"   0.727 0.701 0.701
--   unrelated  "who won the 1998 world cup final?"        0.757 0.728 0.728
--
-- 0.78 sits in the gap between those two groups. It is a property of this
-- model and this corpus, so Stage 6's eval set re-checks it rather than
-- inheriting it as a constant nobody re-measures — and it is a parameter, so
-- a caller that wants everything can ask for everything.
--
-- The lexical half is deliberately *not* filtered: a full-text match is a
-- term the user actually typed appearing in the text, which is evidence on
-- its own terms regardless of what the embedding thinks.

drop function if exists search_chunks(extensions.vector, text, int);

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
    c.content,
    f.similarity,
    f.vector_rank,
    f.lexical_rank,
    f.rrf_score
  from fused f
  join public.chunks c on c.id = f.id
  left join public.documents d on d.id = c.document_id
  order by f.rrf_score desc, c.id
  limit coalesce(match_limit, 5);
$$;

comment on function search_chunks(extensions.vector, text, int, double precision) is
  'Hybrid retrieval over chunks: vector (with a measured relevance floor) + full-text, fused by Reciprocal Rank Fusion (k=60). SECURITY INVOKER — RLS on chunks is the only authorization (ADR 0008).';

revoke all on function search_chunks(extensions.vector, text, int, double precision)
  from public, anon, authenticated, service_role;
grant execute on function search_chunks(extensions.vector, text, int, double precision)
  to authenticated;
