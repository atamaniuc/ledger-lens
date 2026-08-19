import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { AUTH_COOKIE_NAME, publicAnonKey, serverSupabaseUrl } from "./config";

// The Server Component / route handler client. It reads the user's session
// out of the request cookies and issues queries as `authenticated`, so
// Postgres decides what comes back — ADR 0007's whole point.
//
// A new client per render, never a shared module-level one: the session is
// request state, and a cached client would serve one user's rows to the next
// request that arrived.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(serverSupabaseUrl(), publicAnonKey(), {
    cookieOptions: { name: AUTH_COOKIE_NAME },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies, and a refresh that happens
          // during a render lands here. That is expected rather than an
          // error: `proxy.ts` refreshes the session before the render begins,
          // so the tokens it would have written are already current.
        }
      },
    },
  });
}
