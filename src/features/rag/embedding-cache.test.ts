import { beforeEach, describe, expect, it } from "vitest";
import { EmbeddingCache, queryEmbeddingCache } from "./embedding-cache";
import { EMBEDDING_MODEL } from "./embed";

describe("EmbeddingCache", () => {
  beforeEach(() => queryEmbeddingCache.clear());

  it("returns a vector it was given, and counts the hit", () => {
    const cache = new EmbeddingCache();
    cache.set("payment terms", EMBEDDING_MODEL, [0.1, 0.2]);
    expect(cache.get("payment terms", EMBEDDING_MODEL)).toEqual([0.1, 0.2]);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 0, size: 1 });
  });

  it("misses on a different question and on a different model", () => {
    // The model is part of the key because a vector from another model is not
    // a cheaper answer, it is a wrong one — index and query time must share a
    // vector space.
    const cache = new EmbeddingCache();
    cache.set("payment terms", EMBEDDING_MODEL, [0.1]);
    expect(cache.get("payment schedule", EMBEDDING_MODEL)).toBeUndefined();
    expect(cache.get("payment terms", "some-other-model")).toBeUndefined();
    expect(cache.stats().misses).toBe(2);
  });

  it("evicts the least recently used entry once it is full", () => {
    const cache = new EmbeddingCache(2);
    cache.set("a", EMBEDDING_MODEL, [1]);
    cache.set("b", EMBEDDING_MODEL, [2]);
    cache.get("a", EMBEDDING_MODEL); // "a" is now the most recent
    cache.set("c", EMBEDDING_MODEL, [3]);
    expect(cache.get("b", EMBEDDING_MODEL)).toBeUndefined();
    expect(cache.get("a", EMBEDDING_MODEL)).toEqual([1]);
    expect(cache.get("c", EMBEDDING_MODEL)).toEqual([3]);
    expect(cache.stats().size).toBe(2);
  });

  it("refuses a size that could not hold anything", () => {
    expect(() => new EmbeddingCache(0)).toThrow();
  });

  it("is exported as one process-wide instance, and can be emptied", () => {
    queryEmbeddingCache.set("q", EMBEDDING_MODEL, [0.5]);
    expect(queryEmbeddingCache.stats().size).toBe(1);
    queryEmbeddingCache.clear();
    expect(queryEmbeddingCache.stats()).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });
});
