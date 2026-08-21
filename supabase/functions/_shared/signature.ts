// Shared HMAC request signing for the provider-webhook and embed Edge
// Functions (spec 0004, D-19). The previous scheme checked a static header
// secret, so a captured request could be replayed forever. This replaces it
// with HMAC-SHA256 over `v1:<timestamp>:<nonce>:<rawBody>` — the raw body
// bytes, never a re-serialization — verified in constant time via Web
// Crypto, with a freshness window and a single-use nonce.
//
// Pure crypto and parsing, no I/O: the nonce replay check lives in Postgres
// (public.consume_request_nonce) and is called by the function only after
// this check passes, so this module stays importable by both functions and
// carries no runtime-specific import (same shareability rule as
// src/features/ingestion/transform.ts, ADR 0002).

export const SIGNATURE_VERSION = "v1";
/** Freshness window: a timestamp older (or further ahead) than this is stale. */
export const SIGNATURE_TTL_MS = 5 * 60 * 1000;
/** How long a claimed nonce stays single-use in Postgres. */
export const NONCE_TTL_MS = 10 * 60 * 1000;
/** Upper bound on body bytes for both signed entry points. */
export const MAX_BODY_BYTES = 1024 * 1024;

const HEX_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface SignatureHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

export type SignatureCheckResult =
  | { ok: true; timestampMs: number; nonce: string }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "malformed_signature"
        | "malformed_nonce"
        | "stale_timestamp"
        | "invalid_signature";
    };

export function extractSignatureHeaders(req: Request): SignatureHeaders {
  return {
    timestamp: req.headers.get("x-webhook-timestamp"),
    nonce: req.headers.get("x-webhook-nonce"),
    signature: req.headers.get("x-webhook-signature"),
  };
}

export function canonicalString(timestampMs: number, nonce: string, rawBody: string): string {
  return `${SIGNATURE_VERSION}:${timestampMs}:${nonce}:${rawBody}`;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time verification of a request's signature. Every failure path
 * returns a distinct reason for the log; the calling function maps them all
 * to the same client-facing failure shape.
 */
export async function checkRequestSignature(
  headers: SignatureHeaders,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<SignatureCheckResult> {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  if (!HEX_RE.test(signature)) return { ok: false, reason: "malformed_signature" };
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: "malformed_nonce" };

  const timestampMs = Number(timestamp);
  // Non-numeric, float, or padded timestamps land on the same path as an old
  // one: the request is not fresh. This also keeps Number() from silently
  // accepting "123abc" as a timestamp.
  if (!Number.isInteger(timestampMs) || String(timestampMs) !== timestamp) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (Math.abs(nowMs - timestampMs) > SIGNATURE_TTL_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(canonicalString(timestampMs, nonce, rawBody));
  const valid = await crypto.subtle.verify("HMAC", key, hexToBytes(signature), data);
  if (!valid) return { ok: false, reason: "invalid_signature" };

  return { ok: true, timestampMs, nonce };
}
