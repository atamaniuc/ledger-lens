import { describe, expect, it } from "bun:test";
import {
  EMBEDDING_DIMENSIONS,
  EMBED_BATCH_LIMIT,
  EmbeddingError,
  batched,
  embedTexts,
} from "./embed";

const ENV = {
  baseUrl: "http://127.0.0.1:54321",
  anonKey: "anon-key",
  secret: "embed-secret",
};

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
    expect(seen[0].headers["x-embed-secret"]).toBe("embed-secret");
    expect(seen[0].headers.authorization).toBe("Bearer anon-key");
    expect(seen[0].body).toEqual({ texts: ["a", "b"] });
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

    const result = await embedTexts(["a"], { ...ENV, fetchImpl });

    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("gives up after the second 5xx", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(embedTexts(["a"], { ...ENV, fetchImpl })).rejects.toThrow(EmbeddingError);
    expect(calls).toBe(2);
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

    await expect(embedTexts(["a"], { ...ENV, fetchImpl })).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(2);
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

    await expect(embedTexts(["a"], { ...ENV, fetchImpl, timeoutMs: 10 })).rejects.toThrow(
      EmbeddingError,
    );
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
