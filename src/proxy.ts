import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_COOKIE_NAME,
  publicAnonKey,
  serverSupabaseUrl,
} from "@/platform/supabase/config";
import type { Database } from "@/platform/supabase/database.types";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` and the exported
// `middleware` function to `proxy`. Every @supabase/ssr example still uses
// the old names: take their handler body, not their filename. The `edge`
// runtime is not available here and is not configurable — this runs on
// `nodejs`.
//
// Two jobs, both load-bearing:
//
// 1. Refresh the session. Access tokens expire (3600s locally); without a
//    refresh on the way in, a tab left open renders signed-out even though
//    the refresh token is still valid.
// 2. Redirect an unauthenticated request for /dashboard to /login before any
//    of the page renders, so there is no partially-rendered dashboard.
//
// It is not the authorization mechanism. RLS is (ADR 0007). This only
// decides whether a request gets as far as a page.
export async function proxy(request: NextRequest) {
  // Reassigned by setAll below when Supabase rotates the tokens: the
  // response has to be rebuilt from the mutated request so the new cookies
  // are visible both to the render downstream and to the browser.
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    serverSupabaseUrl(),
    publicAnonKey(),
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser, never getSession: getSession trusts whatever is in the cookie,
  // which the browser can write. getUser revalidates it with the auth server.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Where to land after signing in. Read back through a same-origin path
    // check in the callback — an attacker-supplied absolute URL here would
    // otherwise turn the login flow into an open redirect.
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
