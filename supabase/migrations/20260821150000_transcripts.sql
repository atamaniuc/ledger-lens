-- Spec 0009 (D-42): transcripts enter the SAME pipeline as everything else.
--
-- Modal transcribes audio on a serverless GPU and calls the
-- transcribe-webhook Edge Function, which lands the result here: a
-- raw_events row (source 'transcription') plus a documents row (kind
-- 'transcript') that the existing indexer chunks, embeds and searches — or
-- a quarantine row with a reason when the transcript is malformed.
--
-- The pattern is deliberately 20260817143353's: one SECURITY INVOKER
-- function doing the raw_events insert and its downstream counterpart in a
-- single transaction, with the downstream-row check healing an orphan
-- instead of reporting a false duplicate. Validation stays in TypeScript
-- (supabase/functions/transcribe-webhook/transform.ts); this function
-- receives an already-decided outcome, it does not re-implement the schema
-- (ADR 0002).
--
-- Idempotency is keyed on content: raw_events' unique
-- (org_id, source, external_id, event_version) uses external_id = the
-- audio file's sha256, so the same audio submitted twice produces one
-- transcript and one set of chunks.

-- 1. documents gains provenance columns and a 'transcript' kind.
--
-- run_id and raw_event_id are the same audit chain every other data row
-- has (CLAUDE.md: "run_id on every data row"); they are nullable because
-- the existing documents (seeded, app-created) predate this migration.
alter table public.documents
  add column raw_event_id bigint references public.raw_events(id) on delete cascade,
  add column run_id uuid references public.pipeline_runs(id) on delete cascade;

create index documents_raw_event_id_idx on public.documents (raw_event_id);
create index documents_run_id_idx on public.documents (run_id);

alter table public.documents
  drop constraint documents_kind_check;

alter table public.documents
  add constraint documents_kind_check
  check (kind in ('payment_terms','dispute_note','memo','contract','policy','transcript'));

-- 2. Grants. ingest_transcript below runs as SECURITY INVOKER, i.e. as the
-- Edge Function's service_role client; the Stage 5 migration granted
-- service_role SELECT on documents only (the indexer reads), so the
-- function needs INSERT granted back explicitly — least privilege, same
-- discipline as 20260818094500.
grant select, insert on table public.documents to service_role;

-- 3. The atomic single-record ingest for transcripts.
create or replace function public.ingest_transcript(
  p_org_id            uuid,
  p_source            text,
  p_external_id       text,
  p_event_version     text,
  p_payload           jsonb,
  p_payload_hash      text,
  p_run_id            uuid,
  p_pipeline_version  text,
  p_title             text,
  p_kind              text,
  p_body              text,
  p_content_hash      text,
  p_quarantine_reason text,
  p_quarantine_details jsonb
)
returns table (outcome text, raw_event_id bigint)
language plpgsql
-- SECURITY INVOKER, like ingest_raw_event: the caller is the pipeline's
-- service-role client, which bypasses RLS but is still bounded by table
-- grants. A definer-rights function would add an RLS-bypassing surface.
set search_path = ''
as $$
declare
  v_raw_id bigint;
  v_has_downstream boolean;
begin
  insert into public.raw_events (
    org_id, source, external_id, event_version, payload, payload_hash, run_id
  )
  values (
    p_org_id, p_source, p_external_id, p_event_version,
    p_payload, p_payload_hash, p_run_id
  )
  on conflict (org_id, source, external_id, event_version) do nothing
  returning id into v_raw_id;

  if v_raw_id is null then
    select id into v_raw_id
      from public.raw_events
     where org_id = p_org_id
       and source = p_source
       and external_id = p_external_id
       and event_version = p_event_version;

    select exists (select 1 from public.documents where documents.raw_event_id = v_raw_id)
        or exists (select 1 from public.quarantine where quarantine.raw_event_id = v_raw_id)
      into v_has_downstream;

    if v_has_downstream then
      return query select 'duplicate'::text, v_raw_id;
      return;
    end if;
    -- Orphan: raw event present, no downstream row. Fall through and
    -- write the downstream row rather than skipping it.
  end if;

  if p_quarantine_reason is not null then
    insert into public.quarantine (org_id, raw_event_id, run_id, reason, details)
    values (p_org_id, v_raw_id, p_run_id, p_quarantine_reason, p_quarantine_details);
    return query select 'quarantined'::text, v_raw_id;
    return;
  end if;

  insert into public.documents (
    org_id, title, kind, body, content_hash, raw_event_id, run_id
  )
  values (
    p_org_id, p_title, p_kind, p_body, p_content_hash, v_raw_id, p_run_id
  );
  return query select 'written'::text, v_raw_id;
end;
$$;

-- Not a public API surface: only the pipeline's service-role client calls
-- this. anon/authenticated reach the data through RLS-scoped SELECTs.
revoke execute on function public.ingest_transcript(
  uuid, text, text, text, jsonb, text, uuid, text,
  text, text, text, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.ingest_transcript(
  uuid, text, text, text, jsonb, text, uuid, text,
  text, text, text, text, text, jsonb
) to service_role;
