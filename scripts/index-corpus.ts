// Rebuilds the RAG index from the corpus: `documents` text and `invoices`
// rendered to prose, chunked, embedded through the Edge Function, written to
// `chunks`. Idempotent — a second run in a row writes nothing.
//
// Runs as service_role because there is no end user behind it. It is a CLI
// and deliberately not an API route: nothing reachable from a browser should
// be able to trigger an embedding pass over a whole tenant.
//
// Usage: bun run scripts/index-corpus.ts [--org <uuid>]

import { createServiceClient } from "../lib/supabase/service-client";
import { indexCorpus } from "../lib/rag/index-corpus";

const args = process.argv.slice(2);
const orgFlag = args.indexOf("--org");
const orgId = orgFlag === -1 ? undefined : args[orgFlag + 1];

if (orgFlag !== -1 && !orgId) {
  console.error("--org needs an org_id");
  process.exit(1);
}

const correlationId = crypto.randomUUID();
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

const startedAt = Date.now();

try {
  const stats = await indexCorpus(createServiceClient(), { orgId, correlationId, log });
  log("index_corpus_finished", { ...stats, duration_ms: Date.now() - startedAt });
} catch (error) {
  log("index_corpus_failed", { error: String(error) });
  process.exit(1);
}
