// App-side client for the `embed` Edge Function (supabase/functions/embed).
//
// ADR 0008 put retrieval's embeddings behind the Edge Function, so this is the
// only way the application gets a vector — the indexer batches through it, and
// every chat turn embeds the user's question through it. That makes it a
// dependency on the request path, which is why the timeout is explicit and
// small rather than whatever fetch defaults to.

import { signRequest } from "@/platform/signing";

export const EMBEDDING_MODEL = "gte-small";
export const EMBEDDING_DIMENSIONS = 384;
/**
 * Mirrors MAX_TEXTS in the Edge Function; a larger batch is rejected there.
 * Eight because the runtime's per-request CPU budget kills a batch of 16
 * mid-flight (HTTP 546, no partial result), which is a limit rather than a
 * tuning choice.
 */
export const EMBED_BATCH_LIMIT = 8;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The Edge Runtime's own status for "the worker was killed for using too much
 * of something". It is not a server error in the usual sense — the request was
 * too expensive, so the same request will be too expensive again. Retrying it
 * is worth one round of backoff (the isolate may have been recycled since),
 * and after that the answer is a smaller batch, not another attempt.
 */
export const WORKER_LIMIT_STATUS = 546;

/** Four, not two: a killed isolate needs time to be replaced, and the first
 * retry lands too early to find a new one. */
export const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4_000;

export class EmbeddingError extends Error {
  readonly status?: number;
  /**
   * False for a fault a second identical request cannot fix — a 4xx, or a
   * response whose shape is wrong. Retrying those costs a full round trip to
   * arrive at the same failure.
   */
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable?: boolean) {
    super(message);
    this.name = "EmbeddingError";
    this.status = status;
    this.retryable = retryable ?? (status === undefined || status >= 500);
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
  /** Injected so tests do not pay for the backoff they are asserting. */
  sleepImpl?: (ms: number) => Promise<void>;
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

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential with jitter: several indexer batches failing together must not
 * come back in lockstep. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Embeds a batch of texts.
 *
 * Retries a transport failure, a timeout or a 5xx up to `MAX_ATTEMPTS` times
 * with exponential backoff; a 4xx is our bug (a wrong batch, a wrong secret)
 * and is raised immediately, because sending it again is only a slower
 * failure.
 *
 * One fault gets more than a retry. HTTP 546 is the Edge Runtime killing the
 * isolate for exceeding its CPU budget, and it took the whole e2e suite down
 * with an error that named no cause (D-47): after the attempts are spent, a
 * batch of more than one text is **split in half and embedded recursively**,
 * down to single texts if it has to. Order is preserved, so the caller cannot
 * tell — except that the work finishes.
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
  const sleep = opts.sleepImpl ?? realSleep;

  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    // The gateway wants a Supabase key before the function is reached at all;
    // the HMAC below is what the function itself checks.
    authorization: `Bearer ${anonKey}`,
  };
  if (opts.correlationId) baseHeaders["x-correlation-id"] = opts.correlationId;

  // Serialized once: the signature covers the exact bytes that are sent.
  const rawBody = JSON.stringify({ texts });

  let lastError: EmbeddingError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Signed per attempt, never once per batch: the function consumes the
      // nonce in Postgres, so re-sending a signature is a replay and is
      // refused (D-19). A retry has to be a new request, not the same one.
      const signed = await signRequest(secret, rawBody);
      const response = await doFetch(`${baseUrl}/functions/v1/embed`, {
        method: "POST",
        headers: { ...baseHeaders, ...signed },
        body: rawBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new EmbeddingError(
          // The body is carried, not dropped: a 503 whose message said nothing
          // is what made this failure expensive to diagnose.
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
        throw new EmbeddingError(
          "embed function returned the wrong number of vectors",
          undefined,
          false,
        );
      }
      for (const vector of body.embeddings) {
        if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
          // Caught here rather than at the insert, where the message would be
          // a Postgres type error several layers from the cause.
          throw new EmbeddingError(
            "embed function returned a vector of the wrong width",
            undefined,
            false,
          );
        }
      }
      return body.embeddings;
    } catch (error) {
      if (error instanceof EmbeddingError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else {
        // Abort (timeout) and transport failures both land here.
        lastError = new EmbeddingError(`embed request failed: ${String(error)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Out of attempts. A resource limit on a batch is the one fault a smaller
  // request can still satisfy, so try that before giving up.
  if (lastError?.status === WORKER_LIMIT_STATUS && texts.length > 1) {
    const half = Math.ceil(texts.length / 2);
    const left = await embedTexts(texts.slice(0, half), opts);
    const right = await embedTexts(texts.slice(half), opts);
    return [...left, ...right];
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
