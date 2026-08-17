// Web Crypto (crypto.subtle) is a global in both the Next.js/Node
// runtime and Deno — no runtime-specific import needed, so this stays
// shareable the same way transform.ts is (ADR 0002).
export async function hashPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
