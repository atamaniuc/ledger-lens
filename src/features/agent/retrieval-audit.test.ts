import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";
import { runAgentTurn } from "./loop";
import type { ModelClient } from "./providers";

// D-09: llm_calls.retrieved_chunk_ids was always NULL, so retrieval lineage
// was not queryable. Every row the loop writes must carry the chunk ids
// collected so far — an empty array records "nothing retrieved yet", null
// would record "not recorded", and the column exists to make the
// difference.

function usage(input = 10, output = 5) {
  return { input_tokens: input, output_tokens: output };
}

function toolResponse(name: string, input: unknown): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: `tu_${Math.random()}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function stubModel(responses: Anthropic.Message[]) {
  let calls = 0;
  const model: ModelClient = {
    model: "claude-opus-5",
    provider: "stub",
    createMessage: async () => {
      const next = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return next;
    },
  };
  return model;
}

/**
 * Runs the real loop with the embedding round trip and the search RPC
 * stubbed, so the tool runs as written — collectEvidence included.
 */
async function withSearch(
  chunks: Record<string, unknown>[],
  model: ModelClient,
) {
  const realFetch = globalThis.fetch;
  const previousEnv = {
    url: process.env.SUPABASE_URL,
    anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    secret: process.env.EMBED_SHARED_SECRET,
  };
  process.env.SUPABASE_URL = "http://stub.local";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.EMBED_SHARED_SECRET = "secret";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        embeddings: [Array.from({ length: 384 }, () => 0.1)],
        model: "gte-small",
        dimensions: 384,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "search_chunks") return { data: chunks, error: null };
      return { data: rpcs.length, error: null };
    },
    from: () => {
      throw new Error("no table tool should run in this test");
    },
  } as unknown as SupabaseClient<Database>;

  try {
    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "corr-retrieval",
      supabase,
      model,
    });
    return { result, rpcs };
  } finally {
    globalThis.fetch = realFetch;
    process.env.SUPABASE_URL = previousEnv.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousEnv.anon;
    process.env.EMBED_SHARED_SECRET = previousEnv.secret;
  }
}

describe("retrieved_chunk_ids (D-09)", () => {
  it("writes the retrieved chunk ids onto the turn's llm_calls rows", async () => {
    const model = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
    ]);

    const { result, rpcs } = await withSearch(
      [
        {
          chunk_id: 101,
          source_kind: "document",
          document_id: "d1",
          document_title: "Acme terms",
          invoice_id: null,
          invoice_external_id: null,
          content: "Net 30 from the invoice date.",
          similarity: 0.9,
          vector_rank: 1,
          lexical_rank: 1,
          rrf_score: 0.9,
        },
        {
          chunk_id: 102,
          source_kind: "invoice",
          document_id: null,
          document_title: null,
          invoice_id: "i1",
          invoice_external_id: "inv_00001",
          content: "Invoice inv_00001 ...",
          similarity: 0.85,
          vector_rank: 2,
          lexical_rank: 2,
          rrf_score: 0.8,
        },
      ],
      model,
    );

    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    expect(calls.length).toBeGreaterThan(0);
    // The final row of the turn carries the complete retrieved context.
    const last = calls.at(-1);
    expect(last?.args.p_retrieved_chunk_ids).toEqual([101, 102]);
    // And no row in the turn is ever null: [] means "nothing yet", null
    // would mean "not recorded" — the failure D-09 is about.
    for (const call of calls) {
      expect(Array.isArray(call.args.p_retrieved_chunk_ids)).toBe(true);
    }
    expect(result.retrievedChunkIds).toEqual([101, 102]);
  });

  it("writes an empty array, not null, when nothing was retrieved", async () => {
    const model = stubModel([
      toolResponse("search_documents", { query: "parental leave" }),
      toolResponse("search_documents", { query: "leave policy" }),
      textResponse("must never be produced"),
    ]);

    const { rpcs } = await withSearch([], model);

    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Array.isArray(call.args.p_retrieved_chunk_ids)).toBe(true);
    }
    // The terminal abstained row names the bound and still records the
    // retrieval state: nothing, as an array.
    expect(calls.at(-1)?.args.p_outcome).toBe("abstained");
    expect(calls.at(-1)?.args.p_retrieved_chunk_ids).toEqual([]);
  });
});
