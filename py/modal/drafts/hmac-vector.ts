
import { canonicalString } from "../../../supabase/functions/_shared/signature.ts";
const secret = "test-secret-123";
const timestampMs = 1724200000000;
const nonce = "aBcD_eFgH-1234";
const rawBody = '{"org_id":"00000000-0000-4000-8000-000000000001","audio_hash":"abc123"}';
const canonical = canonicalString(timestampMs, nonce, rawBody);
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
console.log(JSON.stringify({ canonical, hex, timestampMs, nonce, rawBody }, null, 2));
