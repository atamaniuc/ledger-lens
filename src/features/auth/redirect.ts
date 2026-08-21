/**
 * The only place a post-sign-in destination is turned into a URL.
 *
 * The `next` parameter travels through a redirect to /login and back out of
 * the callback, which means an attacker controls it. Anything that is not a
 * single-slash-rooted path — an absolute URL, a protocol-relative `//host`,
 * a backslash some parsers normalise to a slash — becomes the dashboard
 * instead. Rejecting rather than sanitising: there is no legitimate caller
 * that needs a cross-origin destination here.
 */
export function safeNextPath(candidate: string | null): string {
  if (!candidate) return "/dashboard";
  if (!candidate.startsWith("/")) return "/dashboard";
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return "/dashboard";
  }
  return candidate;
}
