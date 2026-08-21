// Shared configuration for the two user-facing Supabase clients.
//
// The browser and the server reach the same Supabase project through
// different URLs — the browser over the published port, the server (which
// runs inside the dev container) over the compose network — so the URL
// cannot be a single constant. The *cookie name* can be, and has to be:
// @supabase/ssr derives its default from the project ref in the URL, so two
// different URLs would produce two different cookie names, the server would
// never find the session the browser wrote, and every server render would
// look signed-out. Pinning the name removes that class of bug entirely.
export const AUTH_COOKIE_NAME = "sb-ledgerlens-auth";

/** The anon key. Public by design — RLS is what protects the data. */
export function publicAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  return key;
}

/** The URL the browser uses. Must be reachable from outside any container. */
export function browserSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set");
  return url;
}

/**
 * The URL server-side rendering uses. `SUPABASE_URL` is the in-network
 * address when the app runs in the dev container; outside one it is unset or
 * identical, and the public URL is the right answer.
 */
export function serverSupabaseUrl(): string {
  return process.env.SUPABASE_URL ?? browserSupabaseUrl();
}
