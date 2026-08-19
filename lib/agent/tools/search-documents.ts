import { z } from "zod";
import { searchChunks } from "../../rag/search";
import type { AgentTool } from "./types";

const MAX_RESULTS = 8;

const input = z.object({
  query: z.string().min(1).max(500).describe("A natural-language question or an exact identifier."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .describe(`How many chunks to return, at most ${MAX_RESULTS}. Defaults to 5.`),
});

export type SearchDocumentsInput = z.infer<typeof input>;

export interface SearchedChunk {
  chunk_id: number;
  source_kind: "document" | "invoice";
  document_title: string | null;
  invoice_id: string | null;
  /** What a citation is written with; see migration 20260819210000. */
  invoice_external_id: string | null;
  content: string;
}

export interface SearchDocumentsResult {
  chunks: SearchedChunk[];
}

export const searchDocuments: AgentTool<SearchDocumentsInput, SearchDocumentsResult> = {
  name: "search_documents",
  description:
    "Hybrid search over the organization's documents (payment terms, dispute notes, memos, " +
    "policies) and invoice text. Cite a chunk as [chunk:<chunk_id>], and an invoice as " +
    "[invoice:<invoice_external_id>] when the chunk carries one. An empty result means the corpus " +
    "does not contain an answer — say so rather than guessing.",
  effect: "read",
  input,

  async execute({ supabase, correlationId }, args) {
    // ADR 0008's function is SECURITY INVOKER, so this search sees exactly
    // what the caller's own dashboard would.
    const chunks = await searchChunks(supabase, args.query, {
      matchLimit: args.limit ?? 5,
      correlationId,
    });

    return {
      chunks: chunks.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        source_kind: chunk.source_kind,
        document_title: chunk.document_title,
        invoice_id: chunk.invoice_id,
        invoice_external_id: chunk.invoice_external_id,
        content: chunk.content,
      })),
    };
  },
};
