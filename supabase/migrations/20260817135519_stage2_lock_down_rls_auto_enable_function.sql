-- Pre-existing project safety net (public.rls_auto_enable, an event
-- trigger that force-enables RLS on any new public table) was exposed as
-- a callable RPC to anon/authenticated — flagged by the security
-- advisor. Event triggers fire automatically; they don't need direct
-- role-level EXECUTE, so revoking it closes the RPC surface without
-- touching the trigger's own behavior.
--
-- Guarded because the function is an artifact of the hosted project, not
-- something any migration here creates: on a fresh database (a local
-- `supabase db reset`, CI, or a second hosted project) it does not exist,
-- and an unguarded REVOKE aborts the whole migration run with
-- "function public.rls_auto_enable() does not exist". The revoke still
-- has to ship — dropping it would silently re-open the RPC surface on the
-- one database where the function is real.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;
