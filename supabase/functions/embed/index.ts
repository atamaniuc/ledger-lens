// Deno Edge Function — the only place in this system that turns text into a
// vector. Decision 0008: the model is `gte-small` reached through
// `Supabase.ai.Session` below, which is Supabase's own hosted inference, not a
// model executing inside this isolate. That distinction is the whole point of
// the correction recorded as D-05: the effect is the same (no embeddings API
// key of ours, no second AI vendor, one place a vector can come from) but the
// CPU budget and the 546 below are the runtime's, and the model's latency is
// someone else's service.
//
// Both the indexer and every chat turn come through here.
//
// Verified against supabase-edge-runtime-1.74.3: 384 dimensions.
//
// Auth (D-19): the same HMAC + timestamp + nonce scheme as provider-webhook
// (see ../_shared/signature.ts), keyed with EMBED_SHARED_SECRET. The
// previous static x-embed-secret header could be replayed by anyone who
// captured one request.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  MAX_BODY_BYTES,
  NONCE_TTL_MS,
  checkRequestSignature,
  extractSignatureHeaders,
} from "../_shared/signature.ts";

const EMBED_SECRET = Deno.env.get("EMBED_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const MODEL = "gte-small";
export const DIMENSIONS = 384;
// Measured, not guessed: the Edge Runtime enforces a per-request CPU budget,
// and a batch of 16 texts trips it — the caller gets HTTP 546 WORKER_LIMIT
// with no partial result. Eight embeds in about a second and leaves headroom.
// Raising this is a runtime-limit question, not a preference.
export const MAX_TEXTS = 8;
export const MAX_TEXT_LENGTH = 8_000;

interface EmbedBody {
  texts: unknown;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// @ts-expect-error — Supabase.ai is injected by the Edge Runtime, not imported.
const session = new Supabase.ai.Session(MODEL);

Deno.serve(async (req: Request) => {
  // CLAUDE.md: every log line carries a correlation_id.
  const correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

  // Auth first, like provider-webhook: a rejected call does no work at all.
  // The signature is over the raw body bytes, read here and parsed only
  // after auth.
  if (!EMBED_SECRET) {
    log("embed_unauthorized", { reason: "secret_unset" });
    return json({ error: "unauthorized" }, 401);
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    log("embed_body_too_large", { bytes: rawBody.length });
    return json({ error: "body_too_large" }, 413);
  }

  const signatureCheck = await checkRequestSignature(
    extractSignatureHeaders(req),
    rawBody,
    EMBED_SECRET,
  );
  if (!signatureCheck.ok) {
    log("embed_unauthorized", { reason: signatureCheck.reason });
    return json({ error: "unauthorized" }, 401);
  }

  // Replay guard, same table and RPC as the webhook: the nonce is
  // single-use. Fail closed on any doubt.
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: consumed, error: nonceError } = await supabase.rpc(
    "consume_request_nonce",
    {
      p_nonce: signatureCheck.nonce,
      p_expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    },
  );
  if (nonceError || consumed !== true) {
    log("embed_nonce_rejected", {
      reason: nonceError?.message ?? "reused_nonce",
    });
    return json({ error: "unauthorized" }, 401);
  }

  let body: EmbedBody;
  try {
    body = JSON.parse(rawBody) as EmbedBody;
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  const texts = body?.texts;
  // An empty array is a caller bug, not a request for zero embeddings.
  // Returning `{ embeddings: [] }` would let a broken indexer report success
  // over a corpus it never sent.
  if (!Array.isArray(texts) || texts.length === 0) {
    return json({ error: "texts must be a non-empty array" }, 400);
  }
  if (texts.length > MAX_TEXTS) {
    return json({ error: `texts must hold at most ${MAX_TEXTS} items` }, 400);
  }
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) {
      return json({ error: "every text must be a non-empty string" }, 400);
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return json({ error: `every text must be at most ${MAX_TEXT_LENGTH} characters` }, 400);
    }
  }

  const startedAt = Date.now();
  const embeddings: number[][] = [];
  try {
    for (const text of texts as string[]) {
      const vector = (await session.run(text, {
        mean_pool: true,
        normalize: true,
      })) as number[];
      // A vector of the wrong width would be accepted by the app and rejected
      // by Postgres at insert time, several layers away from the cause.
      if (!Array.isArray(vector) || vector.length !== DIMENSIONS) {
        log("embed_bad_dimensions", { got: Array.isArray(vector) ? vector.length : null });
        return json({ error: "model returned an unexpected vector width" }, 500);
      }
      embeddings.push(vector);
    }
  } catch (error) {
    log("embed_failed", { error: String(error) });
    return json({ error: "embedding failed" }, 500);
  }

  log("embed_ok", { count: embeddings.length, latency_ms: Date.now() - startedAt });
  return json({ embeddings, model: MODEL, dimensions: DIMENSIONS }, 200);
});

// NOTE TO THE PARENT (outside this lane's ownership): the app-side caller,
// src/features/rag/embed.ts, still sends the old `x-embed-secret` header and
// will 401 against this function. It must sign requests with the same scheme
// (checkRequestSignature's canonical string `v1:<timestamp>:<nonce>:<body>`,
// HMAC-SHA256 with EMBED_SHARED_SECRET, headers x-webhook-timestamp /
// x-webhook-nonce / x-webhook-signature). Exact snippet is in the lane report.
