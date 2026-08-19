// Deno Edge Function — the only place in this system that turns text into a
// vector. ADR 0008: `gte-small` runs inside the Edge Runtime, so there is no
// embeddings API key anywhere and no second AI vendor. The app cannot do this
// in-process, which is why both the indexer (Batch D) and every chat turn
// (Batch H) come through here.
//
// Verified against supabase-edge-runtime-1.74.3: 384 dimensions.

const EMBED_SECRET = Deno.env.get("EMBED_SHARED_SECRET");

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
  const provided = req.headers.get("x-embed-secret");
  if (!EMBED_SECRET || provided !== EMBED_SECRET) {
    log("embed_unauthorized");
    return json({ error: "unauthorized" }, 401);
  }

  let body: EmbedBody;
  try {
    body = await req.json();
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
