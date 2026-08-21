// Client half of the request signing that `supabase/functions/_shared/signature.ts`
// verifies (spec 0004, D-19). Both signed entry points — the provider webhook
// and the embed function — check an HMAC over
// `v1:<timestampMs>:<nonce>:<rawBody>`, so anything calling them from this
// side has to produce the same three headers.
//
// Two rules the callers must not get wrong, both encoded here:
//   1. the signature covers the EXACT body bytes that are sent, so the body is
//      serialized once and both signed and posted from the same string;
//   2. a nonce is single-use — the function consumes it in Postgres. A retry
//      therefore needs a FRESH signature, or it is indistinguishable from a
//      replay attack and is refused. `signRequest` is cheap and is meant to be
//      called once per attempt, not once per batch.

const SIGNATURE_VERSION = "v1";

export interface SignedHeaders {
  "x-webhook-timestamp": string;
  "x-webhook-nonce": string;
  "x-webhook-signature": string;
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The string both sides hash. Kept in one place so a change cannot land on one side only. */
function canonicalString(timestampMs: number, nonce: string, rawBody: string): string {
  return `${SIGNATURE_VERSION}:${timestampMs}:${nonce}:${rawBody}`;
}

/** A nonce the verifier's `^[A-Za-z0-9_-]{8,128}$` accepts. */
function newNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function signRequest(
  secret: string,
  rawBody: string,
  opts: { nowMs?: number; nonce?: string } = {},
): Promise<SignedHeaders> {
  const timestampMs = opts.nowMs ?? Date.now();
  const nonce = opts.nonce ?? newNonce();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalString(timestampMs, nonce, rawBody))),
  );
  return {
    "x-webhook-timestamp": String(timestampMs),
    "x-webhook-nonce": nonce,
    "x-webhook-signature": toHex(signature),
  };
}
