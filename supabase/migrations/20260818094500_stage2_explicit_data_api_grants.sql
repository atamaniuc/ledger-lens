-- Explicit table/function grants for the Data API roles.
--
-- Why this exists: the Stage 2 tables were created against a hosted
-- Supabase project old enough to still carry the legacy "auto-expose new
-- entities" default, which silently granted anon/authenticated/service_role
-- full DML on anything created in `public`. That default is gone — new
-- projects, and every local `supabase start`, revoke it. The migrations
-- therefore applied cleanly but produced a database where the ingestion
-- route could not write:
--
--   permission denied for table pipeline_runs
--   permission denied for function reap_abandoned_runs
--
-- Found by running `supabase db reset` against an empty local database for
-- the first time. Relying on a project-level setting no migration expresses
-- is the actual defect; granting explicitly here makes the schema
-- reproducible on any project, old or new.
--
-- Grants are least-privilege per the roles-and-privileges guidance: each
-- role gets the verbs it actually uses and nothing more. RLS is unaffected
-- — a GRANT is permission to attempt a query, the policy still decides
-- which rows come back.

-- Revoke first, then grant. Without the revoke this migration is a no-op on
-- the project that has the legacy default: it only ever adds, so that
-- project keeps anon and authenticated holding SELECT/INSERT/UPDATE/DELETE
-- on every table while a current project has none of it. RLS blocks the
-- writes either way (there is no INSERT/UPDATE/DELETE policy anywhere, and
-- RLS denies what no policy allows), so this is not a live hole — but two
-- databases with different privilege sets is a trap: the next table added
-- without RLS would be world-writable on one and closed on the other, and
-- nothing would report the difference. Revoking makes the end state
-- identical no matter which default the project was created under.
--
-- Scoped to the three Data API roles on purpose. The table owner
-- (`postgres`) and Supabase's internal roles are untouched — revoking from
-- those would break the platform, not tighten it.
revoke all on table
  public.orgs,
  public.memberships,
  public.pipeline_runs,
  public.raw_events,
  public.invoices,
  public.quarantine
from anon, authenticated, service_role;

revoke all on sequence
  public.raw_events_id_seq,
  public.quarantine_id_seq
from anon, authenticated, service_role;

-- anon is never granted anything back. There is no policy for it on any
-- table, so a grant would only widen the surface without enabling a
-- feature.

-- authenticated: read-only. The dashboard (Stage 4) queries as the end user
-- and every row it may see is decided by the org_id RLS policies from
-- 20260817135445. Nothing in the design lets a user write directly — all
-- writes go through the pipeline, which runs as service_role.
grant select on table
  public.orgs,
  public.memberships,
  public.pipeline_runs,
  public.raw_events,
  public.invoices,
  public.quarantine
to authenticated;

-- service_role: the pipeline itself. It bypasses RLS by design (there is no
-- user JWT behind an ingestion run), so its grants are the only thing
-- bounding it — hence verb-by-verb rather than `all privileges`.
--
-- Read-only on the tenant tables: the pipeline resolves orgs and
-- memberships, it never edits them.
grant select on table public.orgs, public.memberships to service_role;

-- pipeline_runs: inserted at run start, updated at close-out and by the
-- reaper. No delete — run history is the audit trail.
grant select, insert, update on table public.pipeline_runs to service_role;

-- raw_events is append-only by design (docs/DATABASE_SCHEMA.md); invoices
-- and quarantine are written once per record by ingest_raw_event, which
-- also SELECTs them to detect duplicates and heal orphans. No update, no
-- delete: correcting a bad row means a new run, not an in-place edit.
grant select, insert on table
  public.raw_events,
  public.invoices,
  public.quarantine
to service_role;

-- bigserial columns on raw_events and quarantine: without sequence usage
-- the inserts above fail at nextval().
grant usage, select on sequence
  public.raw_events_id_seq,
  public.quarantine_id_seq
to service_role;

-- The two pipeline functions. EXECUTE was revoked from public/anon/
-- authenticated when each was created; service_role is the only intended
-- caller and needs it granted back explicitly now that nothing auto-exposes
-- new functions.
grant execute on function public.ingest_raw_event(
  uuid, text, text, text, jsonb, text, uuid, text,
  text, bigint, text, text, date, text, jsonb
) to service_role;

grant execute on function public.reap_abandoned_runs(uuid, text, interval)
  to service_role;
