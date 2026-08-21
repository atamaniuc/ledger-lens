// Idempotent corpus indexer. Reads both halves of the corpus — `documents`
// text and `invoices` rows rendered to prose — and keeps `chunks` in step
// with them.
//
// The bar is Stage 2's, applied to a derived table: running it twice writes
// nothing the second time. What makes that true is the content hash. A chunk
// whose hash is unchanged is not re-embedded, and embedding is the only
// expensive step here.
//
// Runs as service_role: there is no end user behind `task index`, so RLS has
// no JWT to key off. It is a script and an API-less path on purpose — nothing
// in the browser can reach it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_MODEL, batched, embedTexts, type EmbedOptions } from "./embed";
import { chunkText, hashText, renderInvoice, type Chunk, type ChunkOptions } from "./chunk";

export interface IndexStats {
  documents: number;
  invoices: number;
  chunksInserted: number;
  chunksUpdated: number;
  chunksDeleted: number;
  chunksUnchanged: number;
  embeddingsComputed: number;
}

interface StoredChunk {
  id: number;
  chunk_no: number;
  content_hash: string;
}

interface PendingChunk {
  org_id: string;
  document_id: string | null;
  invoice_id: string | null;
  chunk_no: number;
  content: string;
  content_hash: string;
  existing: StoredChunk | undefined;
}

export interface IndexOptions extends ChunkOptions {
  embed?: EmbedOptions;
  correlationId?: string;
  /** Limits the run to one tenant. Absent means every org. */
  orgId?: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const emptyStats = (): IndexStats => ({
  documents: 0,
  invoices: 0,
  chunksInserted: 0,
  chunksUpdated: 0,
  chunksDeleted: 0,
  chunksUnchanged: 0,
  embeddingsComputed: 0,
});

function fail(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function indexCorpus(
  supabase: SupabaseClient,
  opts: IndexOptions = {},
): Promise<IndexStats> {
  const stats = emptyStats();
  const log = opts.log ?? (() => {});

  const documentQuery = supabase.from("documents").select("id, org_id, body").order("id");
  if (opts.orgId) documentQuery.eq("org_id", opts.orgId);
  const { data: documents, error: documentError } = await documentQuery;
  fail("reading documents", documentError);

  const invoiceQuery = supabase
    .from("invoices")
    .select("id, org_id, external_id, customer, amount_cents, currency, status, issued_at, paid_at")
    .order("id");
  if (opts.orgId) invoiceQuery.eq("org_id", opts.orgId);
  const { data: invoices, error: invoiceError } = await invoiceQuery;
  fail("reading invoices", invoiceError);

  const pending: PendingChunk[] = [];
  const staleIds: number[] = [];

  const reconcile = async (
    parent: { org_id: string; document_id: string | null; invoice_id: string | null },
    desired: Chunk[],
  ) => {
    const column = parent.document_id ? "document_id" : "invoice_id";
    const value = parent.document_id ?? parent.invoice_id;
    const { data: stored, error } = await supabase
      .from("chunks")
      .select("id, chunk_no, content_hash")
      .eq(column, value);
    fail(`reading chunks for ${column}=${value}`, error);

    const byNumber = new Map<number, StoredChunk>(
      (stored ?? []).map((row) => [row.chunk_no, row as StoredChunk]),
    );

    for (const chunk of desired) {
      const existing = byNumber.get(chunk.chunk_no);
      if (existing && existing.content_hash === chunk.content_hash) {
        stats.chunksUnchanged++;
        continue;
      }
      pending.push({ ...parent, ...chunk, existing });
    }

    // A source that got shorter leaves chunks behind. Left in place they keep
    // answering questions from text the document no longer contains, which is
    // the failure a stale index actually causes.
    for (const [chunkNo, row] of byNumber) {
      if (chunkNo >= desired.length) staleIds.push(row.id);
    }
  };

  for (const document of documents ?? []) {
    stats.documents++;
    const desired = await chunkText(document.body, opts);
    await reconcile(
      { org_id: document.org_id, document_id: document.id, invoice_id: null },
      desired,
    );
  }

  for (const invoice of invoices ?? []) {
    stats.invoices++;
    const content = renderInvoice(invoice);
    // One invoice is one chunk: the rendering is a sentence long, and
    // splitting it would separate the amount from the identifier.
    const desired: Chunk[] = [{ chunk_no: 0, content, content_hash: await hashText(content) }];
    await reconcile({ org_id: invoice.org_id, document_id: null, invoice_id: invoice.id }, desired);
  }

  if (staleIds.length > 0) {
    const { error } = await supabase.from("chunks").delete().in("id", staleIds);
    fail("deleting stale chunks", error);
    stats.chunksDeleted = staleIds.length;
  }

  for (const batch of batched(pending)) {
    const embeddings = await embedTexts(
      batch.map((chunk) => chunk.content),
      { ...opts.embed, correlationId: opts.correlationId },
    );
    stats.embeddingsComputed += embeddings.length;

    const rows = batch.map((chunk, i) => ({
      org_id: chunk.org_id,
      document_id: chunk.document_id,
      invoice_id: chunk.invoice_id,
      chunk_no: chunk.chunk_no,
      content: chunk.content,
      content_hash: chunk.content_hash,
      embedding: JSON.stringify(embeddings[i]),
      embedding_model: EMBEDDING_MODEL,
      updated_at: new Date().toISOString(),
    }));

    // Two conflict targets, so two upserts: PostgREST names one target per
    // call, and a document chunk can never collide with an invoice chunk.
    const documentRows = rows.filter((row) => row.document_id !== null);
    const invoiceRows = rows.filter((row) => row.invoice_id !== null);

    if (documentRows.length > 0) {
      const { error } = await supabase
        .from("chunks")
        .upsert(documentRows, { onConflict: "document_id,chunk_no" });
      fail("upserting document chunks", error);
    }
    if (invoiceRows.length > 0) {
      const { error } = await supabase
        .from("chunks")
        .upsert(invoiceRows, { onConflict: "invoice_id,chunk_no" });
      fail("upserting invoice chunks", error);
    }

    for (const chunk of batch) {
      if (chunk.existing) stats.chunksUpdated++;
      else stats.chunksInserted++;
    }
  }

  log("index_corpus_done", { ...stats });
  return stats;
}
