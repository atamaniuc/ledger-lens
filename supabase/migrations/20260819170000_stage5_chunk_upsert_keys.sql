-- The chunk upsert keys become plain unique constraints.
--
-- 20260819160000 created them as partial unique indexes (`where document_id
-- is not null`). Postgres can only infer a partial index for ON CONFLICT if
-- the statement repeats the predicate, and PostgREST's `on_conflict=` names
-- columns only — so the indexer's upsert failed with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- The predicate was never doing any work. NULLs are distinct in a unique
-- index, so every invoice chunk (document_id null) already fails to conflict
-- with every other, and the plain constraint enforces exactly what the
-- partial one did. Dropping the predicate makes it inferable.

drop index if exists chunks_document_chunk_no_key;
drop index if exists chunks_invoice_chunk_no_key;

alter table chunks
  add constraint chunks_document_chunk_no_key unique (document_id, chunk_no);
alter table chunks
  add constraint chunks_invoice_chunk_no_key unique (invoice_id, chunk_no);
