import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EMBED_BATCH_LIMIT,
  EmbeddingError,
  MAX_ATTEMPTS,
  WORKER_LIMIT_STATUS,
  backoffMs,
  batched,
  embedTexts,
} from "./embed";

const ENV = {
  baseUrl: "http://127.0.0.1:54321",
  anonKey: "anon-key",
  secret: "embed-secret",
};

// Backoff is real in production and pointless in a unit test: the assertions
// here are about how many requests happen and what comes back, not about time.
const NO_SLEEP = { sleepImpl: async () => {} };

const vector = (fill = 0.1) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

const okResponse = (count: number) =>
  new Response(
    JSON.stringify({
      embeddings: Array.from({ length: count }, (_, i) => vector(i / 100)),
      model: "gte-small",
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("embedTexts", () => {
  it("sends the batch and returns one vector per text", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return okResponse(2);
    }) as unknown as typeof fetch;

    const result = await embedTexts(["a", "b"], { ...ENV, fetchImpl });

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://127.0.0.1:54321/functions/v1/embed");
    expect(seen[0].headers.authorization).toBe("Bearer anon-key");
    expect(seen[0].body).toEqual({ texts: ["a", "b"] });
    // Signed, not secret-in-a-header (D-19): three headers, a hex digest, and
    // a nonce the function's own regex accepts.
    expect(seen[0].headers["x-webhook-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0].headers["x-webhook-nonce"]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(Number(seen[0].headers["x-webhook-timestamp"])).toBeGreaterThan(0);
    expect(seen[0].headers["x-embed-secret"]).toBeUndefined();
  });

  it("signs every attempt with a fresh nonce, because a nonce is single-use", async () => {
    // Re-sending one signature is indistinguishable from a replay attack and
    // the function refuses it, so a retry that reused the nonce would turn a
    // recoverable 5xx into a permanent 401.
    const nonces: string[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      nonces.push(headers["x-webhook-nonce"]);
      calls++;
      return calls === 1 ? new Response("boom", { status: 503 }) : okResponse(1);
    }) as unknown as typeof fetch;

    await embedTexts(["a"], { ...ENV, fetchImpl, ...NO_SLEEP });

    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(2);
  });

  it("passes a correlation_id through when it has one", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return okResponse(1);
    }) as unknown as typeof fetch;

    await embedTexts(["a"], { ...ENV, fetchImpl, correlationId: "corr-1" });

    expect(headers["x-correlation-id"]).toBe("corr-1");
  });

  it("retries once on a 5xx and succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? new Response("boom", { status: 503 }) : okResponse(1);
    }) as unknown as typeof fetch;

    const result = await embedTexts(["a"], { ...ENV, fetchImpl, ...NO_SLEEP });

    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("gives up after MAX_ATTEMPTS 5xx responses", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(embedTexts(["a"], { ...ENV, fetchImpl, ...NO_SLEEP })).rejects.toThrow(
      EmbeddingError,
    );
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("does not retry a 4xx", async () => {
    // A 400 means the batch is wrong and a 401 means the secret is wrong.
    // Sending either again is just a slower failure.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }) as unknown as typeof fetch;

    await expect(embedTexts(["a"], { ...ENV, fetchImpl })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("retries a transport failure, then reports it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(embedTexts(["a"], { ...ENV, fetchImpl, ...NO_SLEEP })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("aborts a request that outlives the timeout", async () => {
    let aborted = false;
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;

    // 50ms, not 10: at ten milliseconds the timer can fire before the abort
    // listener is attached on a loaded machine, and the assertion below then
    // fails for a reason the code did not cause. A timing-sensitive unit test
    // is a flake waiting to happen (D-51), and this one flaked once.
    await expect(
      embedTexts(["a"], { ...ENV, fetchImpl, timeoutMs: 50, ...NO_SLEEP }),
    ).rejects.toThrow(EmbeddingError);
    expect(aborted).toBe(true);
  });

  it("rejects a response with the wrong vector width", async () => {
    // Caught here, not at the Postgres insert several layers away.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ embeddings: [[1, 2, 3]], model: "gte-small", dimensions: 3 }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(embedTexts(["a"], { ...ENV, fetchImpl })).rejects.toThrow(/wrong width/);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const fetchImpl = (async () => okResponse(1)) as unknown as typeof fetch;

    await expect(embedTexts(["a", "b"], { ...ENV, fetchImpl })).rejects.toThrow(/wrong number/);
  });

  it("refuses an empty batch instead of calling the function", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okResponse(0);
    }) as unknown as typeof fetch;

    await expect(embedTexts([], { ...ENV, fetchImpl })).rejects.toThrow(/empty batch/);
    expect(calls).toBe(0);
  });

  it("refuses a batch larger than the function accepts", async () => {
    const texts = Array.from({ length: EMBED_BATCH_LIMIT + 1 }, (_, i) => `t${i}`);
    await expect(embedTexts(texts, { ...ENV, fetchImpl: (async () => okResponse(0)) as unknown as typeof fetch })).rejects.toThrow(
      /exceeds the limit/,
    );
  });
});

describe("batched", () => {
  it("splits at the function's limit by default", () => {
    const items = Array.from({ length: EMBED_BATCH_LIMIT + 1 }, (_, i) => i);
    const batches = batched(items);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(EMBED_BATCH_LIMIT);
    expect(batches[1]).toHaveLength(1);
  });

  it("returns nothing for an empty corpus", () => {
    expect(batched([])).toEqual([]);
  });
});

describe("embedTexts — what is worth retrying", () => {
  it("does not retry a response whose shape is wrong", async () => {
    // A deterministic bug in the function's output cannot be fixed by asking
    // it again; retrying only pays for a second round trip to fail the same
    // way. Counted, because "did not retry" is the whole assertion.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          embeddings: [[0.1, 0.2]],
          model: "gte-small",
          dimensions: EMBEDDING_DIMENSIONS,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(embedTexts(["one"], { ...ENV, fetchImpl })).rejects.toThrow(/wrong width/);
    expect(calls).toBe(1);
  });
});

describe("embedTexts — the Edge Runtime's resource limit (D-47)", () => {
  it("splits the batch when the isolate is killed, and preserves order", async () => {
    // 546 is the runtime killing the worker for cost. The same batch will cost
    // the same again, so after the attempts are spent the answer is a smaller
    // batch — which is the difference between an indexer that finishes and one
    // that reports a status nobody can act on.
    const sizes: number[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
      sizes.push(texts.length);
      if (texts.length > 1) {
        return new Response(JSON.stringify({ code: "WORKER_LIMIT", message: "resource limit" }), {
          status: WORKER_LIMIT_STATUS,
        });
      }
      return new Response(
        JSON.stringify({
          embeddings: [Array.from({ length: EMBEDDING_DIMENSIONS }, () => texts[0].length)],
          model: "gte-small",
          dimensions: EMBEDDING_DIMENSIONS,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await embedTexts(["a", "bb", "ccc", "dddd"], { ...ENV, fetchImpl, ...NO_SLEEP });

    expect(result).toHaveLength(4);
    // Order survives the split: each vector is filled with its own text length.
    expect(result.map((v) => v[0])).toEqual([1, 2, 3, 4]);
    expect(sizes.filter((n) => n === 1)).toHaveLength(4);
    expect(sizes.slice(0, MAX_ATTEMPTS)).toEqual(Array(MAX_ATTEMPTS).fill(4));
  });

  it("carries the response body into the message, so the cause is readable", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "WORKER_LIMIT", message: "resource limit" }), {
        status: WORKER_LIMIT_STATUS,
      })) as unknown as typeof fetch;

    await expect(embedTexts(["only"], { ...ENV, fetchImpl, ...NO_SLEEP })).rejects.toThrow(
      /546: .*WORKER_LIMIT/,
    );
  });

  it("does not split a single text — there is nothing smaller to try", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status: WORKER_LIMIT_STATUS });
    }) as unknown as typeof fetch;

    await expect(embedTexts(["one"], { ...ENV, fetchImpl, ...NO_SLEEP })).rejects.toThrow(/546/);
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("backs off exponentially, with jitter inside a bounded window", () => {
    // Checked through an injected random, so the property is asserted rather
    // than a number pinned to whatever ran first.
    expect(backoffMs(1, () => 0.5)).toBe(300);
    expect(backoffMs(2, () => 0.5)).toBe(600);
    expect(backoffMs(3, () => 0.5)).toBe(1200);
    expect(backoffMs(1, () => 0)).toBe(240);
    expect(backoffMs(1, () => 1)).toBe(360);
    // Capped, so one bad batch cannot stall the indexer.
    expect(backoffMs(10, () => 1)).toBeLessThanOrEqual(4800);
  });
});
