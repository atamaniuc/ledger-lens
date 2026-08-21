// A tiny cache for query embeddings (D-43).
//
// The chat path embeds the user's question on every turn, and the only route to
// a vector is an Edge Function whose per-request CPU budget kills the isolate
// under load (D-47). A repeated question — and in an eval run, in a demo, and
// in a conversation with a follow-up, questions repeat constantly — should not
// pay for that twice.
//
// Deliberately small and process-local: the app is serverless, so this is a
// per-instance warm cache, never a correctness mechanism. Two consequences,
// both stated rather than discovered later: a cold instance embeds again, and
// an entry can only ever be right, because the key is the exact text and the
// model that produced the vector.

const DEFAULT_MAX_ENTRIES = 256;

interface Entry {
  key: string;
  vector: number[];
}

export class EmbeddingCache {
  private readonly entries = new Map<string, Entry>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {
    if (maxEntries < 1) throw new Error("embedding cache needs room for at least one entry");
  }

  private static key(text: string, model: string): string {
    return `${model}\u0000${text}`;
  }

  get(text: string, model: string): number[] | undefined {
    const key = EmbeddingCache.key(text, model);
    const found = this.entries.get(key);
    if (!found) {
      this.missCount++;
      return undefined;
    }
    // Re-insert so the most recently used entry is last: Map preserves
    // insertion order, which is all the LRU this needs.
    this.entries.delete(key);
    this.entries.set(key, found);
    this.hitCount++;
    return found.vector;
  }

  set(text: string, model: string, vector: number[]): void {
    const key = EmbeddingCache.key(text, model);
    this.entries.delete(key);
    this.entries.set(key, { key, vector });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Hits and misses, for the log line that says whether the cache is earning its keep. */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}

/** The process-wide cache the retrieval path uses. */
export const queryEmbeddingCache = new EmbeddingCache();
