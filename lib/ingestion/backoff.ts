// Exponential backoff + jitter, with an escape hatch for honoring a
// server-supplied Retry-After. Deliberately doesn't know about circuit
// breakers or "5 consecutive failures" — that decision lives in the
// caller (ingestion route / webhook function), per ADR 0003:
// keeping this primitive reusable and boring.

export class RetryableError extends Error {
  /** If set, wait exactly this long instead of computing backoff (e.g. a 429's Retry-After). */
  retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Ceiling on *computed* backoff. Does not cap an explicit Retry-After. */
  maxDelayMs?: number;
  /**
   * Ceiling on an explicit `Retry-After`. Separate from `maxDelayMs`
   * because US-02 requires honoring the provider's number, which can
   * legitimately exceed our own backoff ceiling — but an unbounded value
   * would let one bad header stall a whole invocation.
   */
  maxRetryAfterMs?: number;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;

      const explicitDelay = err instanceof RetryableError ? err.retryAfterMs : undefined;
      // `??` doesn't catch NaN (NaN isn't nullish), and setTimeout coerces
      // NaN to 1ms — a malformed Retry-After would become a near-instant
      // retry storm against a provider that just asked us to slow down.
      // Require a finite number, not merely a non-nullish one.
      if (Number.isFinite(explicitDelay)) {
        await sleep(Math.min(maxRetryAfterMs, explicitDelay as number));
        continue;
      }

      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * backoff * 0.25;
      // Clamp after adding jitter, not before — clamping the base first let
      // the final delay exceed maxDelayMs by up to 25%.
      await sleep(Math.min(maxDelayMs, backoff + jitter));
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
