-- Advisor: function_search_path_mutable. A mutable search_path lets a
-- caller's search_path decide which schema's `raw_events`/`invoices`/
-- `quarantine` this function resolves to. Pinning it to the empty string
-- forces every reference to be schema-qualified, so the function always
-- touches the tables it was written against.
--
-- Body is otherwise identical to 20260817143353's — see that migration's
-- comments for why this function exists at all.
create or replace function public.ingest_raw_event(
  p_org_id            uuid,
  p_source            text,
  p_external_id       text,
  p_event_version     text,
  p_payload           jsonb,
  p_payload_hash      text,
  p_run_id            uuid,
  p_pipeline_version  text,
  p_customer          text,
  p_amount_cents      bigint,
  p_currency          text,
  p_status            text,
  p_issued_at         date,
  p_quarantine_reason text,
  p_quarantine_details jsonb
)
returns table (outcome text, raw_event_id bigint)
language plpgsql
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

    select exists (select 1 from public.invoices   where invoices.raw_event_id   = v_raw_id)
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

  insert into public.invoices (
    org_id, external_id, customer, amount_cents, currency, status,
    issued_at, raw_event_id, run_id, pipeline_version
  )
  values (
    p_org_id, p_external_id, p_customer, p_amount_cents, p_currency, p_status,
    p_issued_at, v_raw_id, p_run_id, p_pipeline_version
  );
  return query select 'written'::text, v_raw_id;
end;
$$;

revoke execute on function public.ingest_raw_event(
  uuid, text, text, text, jsonb, text, uuid, text,
  text, bigint, text, text, date, text, jsonb
) from public, anon, authenticated;
