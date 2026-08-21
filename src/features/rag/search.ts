// Hybrid retrieval, called through the caller's own client.
//
// There is deliberately no `orgId` parameter. ADR 0008 made `search_chunks`
// SECURITY INVOKER so the caller's RLS policy decides what either half of the
// search can see; an org filter here would be application code re-deciding
// something Postgres has already decided, and the first place a tenant leak
// could hide.

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_MODEL, embedTexts, type EmbedOptions } from "./embed";
import { queryEmbeddingCache } from "./embedding-cache";

const DEFAULT_MATCH_LIMIT = 5;

/**
 * Cosine-similarity floor on the vector half, measured against this corpus
 * and `gte-small`. Below it a result is a nearest neighbour rather than an
 * answer — and without a floor, "empty retrieval" is a state a vector search
 * never reaches, so US-06's abstention could never fire.
 *
 * **Raised from 0.78 to 0.80 by Stage 6's eval set**, which is what an eval
 * set is for. Migration 20260819200000 measured the floor against three
 * unrelated queries; the dataset added more, and "what is the office wifi
 * password?" scored 0.791 — above the old floor, so an unanswerable question
 * retrieved five confident chunks.
 *
 * The margin is thin: 0.791 unrelated against 0.803 for the weakest relevant
 * chunk still in range. Top-ranked relevant chunks sit at 0.86–0.89, so
 * recall is unaffected. The 80-case eval set (spec 0007) re-measures the
 * floor on every run: the `abstention` metric fails the gate if an
 * unanswerable query ever retrieves chunks again.
 *
 * This constant is the single source of the floor (D-31). Migration
 * 20260821130000 removed the SQL function's default (0.78) and its internal
 * coalesce fallback, so a hand-written RPC call that omits `min_similarity`
 * fails loudly instead of silently searching at a different floor. The unit
 * test in search.test.ts greps every migration for a re-introduced default or
 * fallback and fails if the two ever disagree again.
 */
export const DEFAULT_MIN_SIMILARITY = 0.8;

export interface RetrievedChunk {
  chunk_id: number;
  source_kind: "document" | "invoice";
  document_id: string | null;
  document_title: string | null;
  invoice_id: string | null;
  /**
   * The id a citation is written with. Carried alongside the uuid because the
   * agent cites `[invoice:<external_id>]` — without it a true citation made
   * from a search result cannot be verified (migration 20260819210000).
   */
  invoice_external_id: string | null;
  content: string;
  similarity: number | null;
  vector_rank: number | null;
  lexical_rank: number | null;
  rrf_score: number;
}

export interface SearchOptions {
  matchLimit?: number;
  /** Pass 0 to disable the floor entirely — an explicit choice, not a default. */
  minSimilarity?: number;
  embed?: EmbedOptions;
  correlationId?: string;
  /** Skips the embedding round trip when the caller already has the vector. */
  embedding?: number[];
}

class RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}

/**
 * Embeds the question and runs the fused search. An empty result is a real
 * answer, not a failure: US-06's abstention depends on the difference.
 */
export async function searchChunks(
  supabase: SupabaseClient,
  query: string,
  opts: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new RetrievalError("search called with an empty query");

  // The query embedding is cached per process (D-43): the only path to a vector
  // is an Edge Function with a per-request CPU budget, and a repeated question
  // should not pay for it twice. A caller that supplies its own embedding skips
  // both the cache and the call.
  let embedding = opts.embedding;
  if (!embedding) {
    const cached = queryEmbeddingCache.get(trimmed, EMBEDDING_MODEL);
    if (cached) {
      embedding = cached;
    } else {
      embedding = (
        await embedTexts([trimmed], { ...opts.embed, correlationId: opts.correlationId })
      )[0];
      queryEmbeddingCache.set(trimmed, EMBEDDING_MODEL, embedding);
    }
  }

  const { data, error } = await supabase.rpc("search_chunks", {
    // PostgREST hands the array to Postgres as JSON; the vector type parses
    // its own text form, which is what this is.
    query_embedding: JSON.stringify(embedding),
    query_text: trimmed,
    match_limit: opts.matchLimit ?? DEFAULT_MATCH_LIMIT,
    min_similarity: opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
  });

  if (error) throw new RetrievalError(`search_chunks failed: ${error.message}`);
  return (data ?? []) as RetrievedChunk[];
}

