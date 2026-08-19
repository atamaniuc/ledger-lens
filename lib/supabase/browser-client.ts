import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { AUTH_COOKIE_NAME, browserSupabaseUrl, publicAnonKey } from "./config";

// The browser's client. Carries the signed-in user's JWT, so every query it
// makes is subject to the same RLS policies as a server render — see ADR
// 0007. Used for the genuinely interactive reads (lineage drill-down,
// pagination) and for the Realtime subscription.
//
// This is the client that may reach the browser bundle. `service-client.ts`
// may not, and an ESLint rule enforces that rather than trusting the name.
export function createClient() {
  return createBrowserClient<Database>(browserSupabaseUrl(), publicAnonKey(), {
    cookieOptions: { name: AUTH_COOKIE_NAME },
  });
}
