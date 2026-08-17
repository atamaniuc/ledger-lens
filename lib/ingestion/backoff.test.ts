import { describe, test, expect } from "bun:test";
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
});
