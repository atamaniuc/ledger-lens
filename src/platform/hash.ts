// One SHA-256-to-hex routine. There were two: `hashText` in the chunker and
// `hashPayload` in ingestion, four identical lines each, differing only in what
// they encoded first (ponytail's "shrink" finding, D-41). Two copies of a hash
// is a quiet way to end up with two different content keys.
//
// Web Crypto (`crypto.subtle`) is a global in the Next.js/Node runtime and in
// Deno, so this module needs no runtime-specific import and stays shareable
// with `supabase/functions/**` the same way `transform.ts` is (decision 0002).

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Content key for a raw event: the SHA-256 of its JSON, hex. Matches
 * `encode(sha256(convert_to(t,'UTF8')),'hex')` in SQL, so `raw_events.payload_hash`
 * means the same thing whichever side wrote it.
 *
 * It lives here, beside the digest, rather than in a feature module that
 * imports this one — and that is not tidiness. This file is imported directly
 * by the Deno Edge Functions, where TypeScript path aliases do not exist: a
 * shared module that imported `@/platform/hash` type-checked fine and then
 * failed at runtime with `worker boot error: Relative import path "@/platform/hash"
 * not prefixed with / or ./ or ../`. Everything reachable from a function must
 * import relatively or not at all. Recorded as D-49.
 */
export async function hashPayload(payload: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(payload));
}
