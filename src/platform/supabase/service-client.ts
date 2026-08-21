import { createClient } from "@supabase/supabase-js";

// Service-role client — server-only. The ingestion route and the
// provider-webhook Edge Function both act as the pipeline itself, not as
// a specific end user, so there's no user JWT for Postgres RLS to key
// off of; the service role bypasses RLS for these writes by design.
//
// Never import this from a client component or anything that reaches
// the browser bundle — see CLAUDE.md's Domain-Specific Rules ("no
// service_role key in client code"). The dashboard (Stage 4) reads
// through the user's own JWT instead, so RLS applies there normally.
export function createServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
