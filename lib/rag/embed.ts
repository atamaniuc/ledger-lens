// App-side client for the `embed` Edge Function (supabase/functions/embed).
//
// ADR 0008 put the model in the Edge Runtime, so this is the only way the
// application gets a vector — the indexer batches through it, and every chat
// turn embeds the user's question through it. That makes it a dependency on
// the request path, which is why the timeout is explicit and small rather
// than whatever fetch defaults to.

export const EMBEDDING_MODEL = "gte-small";
export const EMBEDDING_DIMENSIONS = 384;
/** Mirrors MAX_TEXTS in the Edge Function; a larger batch is rejected there. */
export const EMBED_BATCH_LIMIT = 64;

export const DEFAULT_TIMEOUT_MS = 20_000;

export class EmbeddingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingError";
    this.status = status;
  }
}

export interface EmbedOptions {
  /** Defaults to the request's own Supabase URL from the environment. */
  baseUrl?: string;
  anonKey?: string;
  secret?: string;
  timeoutMs?: number;
  correlationId?: string;
  fetchImpl?: typeof fetch;
}

interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

function requiredEnv(name: string, provided: string | undefined): string {
  const value = provided ?? process.env[name];
  if (!value) throw new EmbeddingError(`${name} is not set`);
  return value;
}

/**
 * Embeds a batch of texts. Retries **once**, and only on a transport failure,
 * a timeout, or a 5xx — a 400 means the batch itself is wrong and sending it
 * again would only be slower, and a 401 means the secret is wrong, which no
 * amount of retrying fixes.
 */
export async function embedTexts(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) {
    throw new EmbeddingError("embedTexts called with an empty batch");
  }
  if (texts.length > EMBED_BATCH_LIMIT) {
    throw new EmbeddingError(`batch of ${texts.length} exceeds the limit of ${EMBED_BATCH_LIMIT}`);
  }

  const baseUrl = requiredEnv("SUPABASE_URL", opts.baseUrl).replace(/\/$/, "");
  const anonKey = requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", opts.anonKey);
  const secret = requiredEnv("EMBED_SHARED_SECRET", opts.secret);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // The gateway wants a Supabase key before the function is reached at all;
    // the shared secret is what the function itself checks.
    authorization: `Bearer ${anonKey}`,
    "x-embed-secret": secret,
  };
  if (opts.correlationId) headers["x-correlation-id"] = opts.correlationId;

  let lastError: EmbeddingError | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}/functions/v1/embed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new EmbeddingError(
          `embed function returned ${response.status}: ${detail.slice(0, 200)}`,
          response.status,
        );
        // 4xx is our bug, not a blip.
        if (response.status < 500) throw error;
        lastError = error;
        continue;
      }

      const body = (await response.json()) as EmbedResponse;
      if (!Array.isArray(body?.embeddings) || body.embeddings.length !== texts.length) {
        throw new EmbeddingError("embed function returned the wrong number of vectors");
      }
      for (const vector of body.embeddings) {
        if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
          // Caught here rather than at the insert, where the message would be
          // a Postgres type error several layers from the cause.
          throw new EmbeddingError("embed function returned a vector of the wrong width");
        }
      }
      return body.embeddings;
    } catch (error) {
      if (error instanceof EmbeddingError) {
        if (error.status !== undefined && error.status < 500) throw error;
        lastError = error;
      } else {
        // Abort (timeout) and transport failures both land here.
        lastError = new EmbeddingError(`embed request failed: ${String(error)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new EmbeddingError("embed request failed");
}

/** Splits a corpus into batches the Edge Function will accept. */
export function batched<T>(items: T[], size = EMBED_BATCH_LIMIT): T[][] {
  if (size < 1) throw new EmbeddingError("batch size must be at least 1");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
