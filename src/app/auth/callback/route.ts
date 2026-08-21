import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { safeNextPath } from "@/features/auth/redirect";
import { createClient } from "@/platform/supabase/server-client";

// Where a magic link lands. Two shapes arrive here, and both have to work:
//
// - `?code=…` — the PKCE flow the in-app login form starts. Supabase's
//   /auth/v1/verify endpoint redirects here after the user clicks the link.
// - `?token_hash=…&type=…` — what GoTrue's admin `generate_link` produces.
//   The end-to-end suite uses it to sign in without an inbox, which also
//   sidesteps the local stack's two-emails-per-hour rate limit.
//
// Exchanging either one writes the session cookies through the server
// client, which is why this is a route handler and not a page: a Server
// Component cannot set cookies.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  let failure: string | null = null;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failure = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    failure = error?.message ?? null;
  } else {
    failure = "missing token";
  }

  if (failure) {
    const url = new URL("/login", origin);
    // A code from a closed set, never the provider's message. /login renders
    // whatever lands in this parameter, so passing text through would let
    // anyone put a sentence of their choosing on our sign-in page — "your
    // account is locked, call this number" is a phishing page we hosted.
    // The codes still separate the cases a user can act on differently: an
    // expired link needs a new one, a used one means they already have a
    // session somewhere.
    url.searchParams.set("error", classify(failure));
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(next, origin));
}

/** Maps a provider message onto the small set /login knows how to render. */
function classify(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("expired")) return "expired";
  if (text.includes("missing token")) return "missing";
  if (text.includes("already") || text.includes("used")) return "used";
  return "invalid";
}
