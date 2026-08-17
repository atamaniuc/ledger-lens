-- Pre-existing project safety net (public.rls_auto_enable, an event
-- trigger that force-enables RLS on any new public table) was exposed as
-- a callable RPC to anon/authenticated — flagged by the security
-- advisor. Event triggers fire automatically; they don't need direct
-- role-level EXECUTE, so revoking it closes the RPC surface without
-- touching the trigger's own behavior.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
