import { describe, test, expect } from "vitest";
import { withRetry, RetryableError } from "./backoff";

describe("withRetry", () => {
  test("retries up to maxAttempts then throws", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new RetryableError("always fails");
    };

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });

  test("honors an explicit retryAfterMs on a RetryableError", async () => {
    let calls = 0;
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error - stub setTimeout to capture requested delays without waiting
    globalThis.setTimeout = (cb: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(cb, 0);
    };

    try {
      const fn = async () => {
        calls++;
        if (calls === 1) throw new RetryableError("rate limited", 777);
        return "ok";
      };

      const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 });
      expect(result).toBe("ok");
      expect(delays[0]).toBe(777);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("an explicit Retry-After is honored past maxDelayMs but capped at maxRetryAfterMs", async () => {
    const delays = await captureDelays(async () => {
      let calls = 0;
      await withRetry(
        async () => {
          calls++;
          if (calls === 1) throw new RetryableError("rate limited", 60_000);
          return "ok";
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, maxRetryAfterMs: 30_000 },
      );
    });
    // Not clamped down to maxDelayMs (5) — US-02 requires honoring the
    // provider's number — but not unbounded either.
    expect(delays[0]).toBe(30_000);
  });

  test("a NaN retryAfterMs falls back to computed backoff, never a 1ms spin", async () => {
    const delays = await captureDelays(async () => {
      let calls = 0;
      await withRetry(
        async () => {
          calls++;
          // What `Number(<HTTP-date Retry-After>)` produces. `?? ` would let
          // this through, and setTimeout coerces NaN to 1ms — a retry storm
          // against a provider that just asked us to back off.
          if (calls === 1) throw new RetryableError("rate limited", Number.NaN);
          return "ok";
        },
        { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 5000 },
      );
    });
    expect(Number.isNaN(delays[0])).toBe(false);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
  });

  test("onRetry reports each retry with the delay before it is applied", async () => {
    const retries: {
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      error: unknown;
    }[] = [];
    let calls = 0;

    const delays = await captureDelays(async () => {
      await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw new RetryableError("flaky");
          return "ok";
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 500,
          onRetry: (info) => retries.push(info),
        },
      );
    });

    // Two failures before the third attempt succeeds, each reported before
    // its delay, and the delays were actually applied (captured by the
    // stubbed setTimeout).
    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].nextAttempt).toBe(2);
    expect(retries[1].attempt).toBe(2);
    expect(retries[1].nextAttempt).toBe(3);
    expect(retries[0].error).toBeInstanceOf(RetryableError);
    expect(retries[0].delayMs).toBeGreaterThanOrEqual(100);
    expect(retries[0].delayMs).toBeLessThanOrEqual(500);
    expect(delays).toHaveLength(2);
  });

  test("computed backoff never exceeds maxDelayMs once jitter is added", async () => {
    const delays = await captureDelays(async () => {
      await withRetry(
        async () => {
          throw new RetryableError("always fails");
        },
        { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1200 },
      ).catch(() => undefined);
    });
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(1200);
  });
});

/** Runs `fn` with setTimeout stubbed so requested delays are recorded, not waited on. */
async function captureDelays(fn: () => Promise<void>): Promise<number[]> {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  // @ts-expect-error - stub setTimeout to capture requested delays without waiting
  globalThis.setTimeout = (cb: () => void, ms: number) => {
    delays.push(ms);
    return originalSetTimeout(cb, 0);
  };
  try {
    await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  return delays;
}
