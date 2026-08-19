// Hybrid retrieval, called through the caller's own client.
//
// There is deliberately no `orgId` parameter. ADR 0008 made `search_chunks`
// SECURITY INVOKER so the caller's RLS policy decides what either half of the
// search can see; an org filter here would be application code re-deciding
// something Postgres has already decided, and the first place a tenant leak
// could hide.

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, type EmbedOptions } from "./embed";

export const DEFAULT_MATCH_LIMIT = 5;

/**
 * Cosine-similarity floor on the vector half, measured against this corpus
 * and `gte-small` (migration 20260819200000 carries the numbers). Below it a
 * result is a nearest neighbour rather than an answer — and without a floor,
 * "empty retrieval" is a state a vector search never reaches, so US-06's
 * abstention could never fire.
 */
export const DEFAULT_MIN_SIMILARITY = 0.78;

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

export class RetrievalError extends Error {
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

  const embedding =
    opts.embedding ??
    (await embedTexts([trimmed], { ...opts.embed, correlationId: opts.correlationId }))[0];

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

/** The ids an answer is allowed to cite, given what a search returned. */
export function citableIds(chunks: RetrievedChunk[]): {
  chunkIds: Set<number>;
  invoiceIds: Set<string>;
} {
  return {
    chunkIds: new Set(chunks.map((chunk) => chunk.chunk_id)),
    invoiceIds: new Set(
      chunks
        .map((chunk) => chunk.invoice_external_id)
        .filter((id): id is string => id !== null),
    ),
  };
}
