import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { searchChunks } from "@/features/rag/search";
import type { Database } from "@/platform/supabase/database.types";
import { ingest } from "./helpers/api";
import { ORG_A, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 5, Batch E: hybrid retrieval, exercised through a real signed-in user.
//
// Two things are being proved here, and the second is the one that matters.
//
// Quality: a fixed query set has to find its target inside the top 5, because
// Stage 6 gates CI on recall@5 ≥ 0.8 and a number measured after the agent is
// built on top of retrieval is a number measured too late.
//
// Isolation: every query below is issued with a user's JWT and no tenant
// filter at all. `search_chunks` is SECURITY INVOKER, so if that ever changed
// — or a policy regressed — Globex's user would start seeing Acme's text and
// the cross-tenant cases would go red.

let apiUrl: string;
let anonKey: string;

const RECALL_THRESHOLD = 0.8;

async function clientFor(email: string): Promise<SupabaseClient<Database>> {
  const supabase = createClient<Database>(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return supabase;
}

// Fixed on purpose. These are the same cases Stage 6's dataset grows from,
// and a query set that drifts measures nothing.
const RECALL_CASES = [
  {
    user: "alice@acme.test",
    query: "what discount do we give for paying an invoice early?",
    expect: "Acme standard payment terms",
  },
  {
    user: "alice@acme.test",
    query: "why was invoice INV-2043 disputed?",
    expect: "Northwind Traders dispute, invoice INV-2043",
  },
  {
    user: "alice@acme.test",
    query: "why did the March month-end close run late?",
    expect: "Acme month-end close memo, March",
  },
  {
    user: "bob@globex.test",
    query: "when do we write off an overdue invoice?",
    expect: "Globex standard payment terms",
  },
  {
    user: "bob@globex.test",
    query: "does the dashboard show recognised revenue or invoiced value?",
    expect: "Globex revenue recognition policy",
  },
];

test.beforeAll(async ({ request }) => {
  // Rebuilding the whole index means ~366 embeddings through the Edge
  // Function, which the runtime's per-request CPU budget caps at eight per
  // call — about 45 seconds from empty, well past the default 30s hook
  // timeout. It only costs that when a previous spec truncated the corpus.
  test.setTimeout(300_000);

  ({ apiUrl, anonKey } = localStack());

  // Own precondition. The corpus is seeded documents plus indexed invoices,
  // so both have to exist before any of this measures anything.
  const [{ count: invoices }] = await sql<{ count: number }[]>`
    select count(*)::int from invoices where org_id = ${ORG_A}`;
  if (invoices === 0) await ingest(request, ORG_A);

  // Rebuilt here rather than assumed, because `tests/stage2-ingestion.spec.ts`
  // truncates `invoices ... cascade` and `chunks` references it — so whether
  // an index exists at this point depends on file order, which is exactly the
  // kind of dependency the Stage 4 specs refused to take. The indexer is
  // idempotent, so this costs a second when the corpus is already indexed.
  // stderr is captured, not discarded: this rebuild has flaked once, and
  // `stdio: "ignore"` turned the reason into "Command failed".
  try {
    execFileSync("pnpm", ["exec", "tsx", "scripts/index-corpus.ts"], { stdio: "pipe" });
  } catch (error) {
    const detail = error as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(
      `index-corpus failed:\n${detail.stderr?.toString() ?? ""}\n${detail.stdout?.toString() ?? ""}`,
    );
  }

  const [{ count: chunks }] = await sql<{ count: number }[]>`
    select count(*)::int from chunks`;
  expect(chunks, "the indexer produced no chunks").toBeGreaterThan(0);
});

test.describe("Stage 5 — hybrid retrieval", () => {
  test("the fixed query set clears the recall@5 bar Stage 6 will gate on", async () => {
    let hits = 0;
    const misses: string[] = [];

    for (const testCase of RECALL_CASES) {
      const supabase = await clientFor(testCase.user);
      const results = await searchChunks(supabase, testCase.query);
      const titles = results.map((chunk) => chunk.document_title);
      if (titles.includes(testCase.expect)) hits++;
      else misses.push(`${testCase.query} -> ${JSON.stringify(titles)}`);
    }

    const recall = hits / RECALL_CASES.length;
    // Reported either way: the number is the point, not just the pass.
    console.log(`recall@5 = ${recall.toFixed(2)} (${hits}/${RECALL_CASES.length})`);
    expect(recall, `misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  test("a question only a document can answer beats every invoice chunk", async () => {
    // The corpus is 98% invoice text by row count. If the vector half were
    // the only half, or the fusion were wrong, the specific document would be
    // buried under three hundred near-identical invoice renderings.
    const supabase = await clientFor("alice@acme.test");
    const results = await searchChunks(supabase, "what is our early settlement discount?");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source_kind).toBe("document");
    expect(results[0].document_title).toBe("Acme standard payment terms");
  });

  test("an exact invoice identifier is found by the lexical half", async () => {
    // A 384-dimension model is worst at exactly this: an identifier carries
    // no meaning to embed. It is why the fusion has a second half at all.
    const supabase = await clientFor("alice@acme.test");
    const [{ external_id }] = await sql<{ external_id: string }[]>`
      select external_id from invoices where org_id = ${ORG_A} order by external_id limit 1`;

    const results = await searchChunks(supabase, external_id);
    const found = results.find((chunk) => chunk.content.includes(external_id));

    expect(found, `no chunk mentioning ${external_id} in the top 5`).toBeDefined();
    expect(found?.lexical_rank).not.toBeNull();
  });

  test("both halves contribute — a result set is not one list twice", async () => {
    const supabase = await clientFor("alice@acme.test");
    const results = await searchChunks(supabase, "overdue invoice interest and collections", {
      matchLimit: 10,
    });

    expect(results.some((chunk) => chunk.vector_rank !== null)).toBe(true);
    expect(results.some((chunk) => chunk.lexical_rank !== null)).toBe(true);
    // Fused scores are the ordering, so they have to be monotonic.
    const scores = results.map((chunk) => chunk.rrf_score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("a Globex user never retrieves Acme's text, however they ask", async () => {
    // US-03, the indirect path: no tenant filter is passed here, and none is
    // passed inside the function either. RLS is the only thing saying no.
    const supabase = await clientFor("bob@globex.test");

    const acmeTitles = [
      "Acme standard payment terms",
      "Northwind Traders dispute, invoice INV-2043",
      "Acme month-end close memo, March",
      "Vendor onboarding note (contains a prompt-injection fixture)",
    ];

    for (const query of [
      "Acme standard payment terms",
      "Northwind Traders dispute",
      "early settlement discount of two percent",
      "invoice INV-2043",
    ]) {
      const results = await searchChunks(supabase, query, { matchLimit: 10 });
      for (const chunk of results) {
        expect(acmeTitles).not.toContain(chunk.document_title);
      }
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int from chunks
        where org_id = ${ORG_A} and id = any(${results.map((chunk) => chunk.chunk_id)}::bigint[])`;
      expect(count, `query "${query}" returned Acme chunks to a Globex user`).toBe(0);
    }
  });

  test("a question this corpus cannot answer returns nothing", async () => {
    // The relevance floor, and the reason it exists: a nearest-neighbour
    // search always has nearest neighbours, so without a floor US-06's
    // abstention could never fire — the agent would compose an answer over
    // five confident, irrelevant chunks.
    const supabase = await clientFor("alice@acme.test");

    for (const query of [
      "what is our parental leave policy?",
      "how do I bake sourdough bread at home?",
      "who won the 1998 world cup final?",
    ]) {
      const results = await searchChunks(supabase, query);
      expect(results, `"${query}" should retrieve nothing`).toHaveLength(0);
    }
  });

  test("the floor is a parameter, not a wall", async () => {
    // Asking for everything is allowed — it just has to be asked for.
    const supabase = await clientFor("alice@acme.test");
    const results = await searchChunks(supabase, "what is our parental leave policy?", {
      minSimilarity: 0,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test("a relevant question stays well clear of the floor", async () => {
    // The positive control for the floor: if it ever drifts up into the
    // relevant band, this goes red before recall does.
    const supabase = await clientFor("alice@acme.test");
    const results = await searchChunks(supabase, "what is our early settlement discount?");

    expect(results.length).toBeGreaterThan(0);
    const best = results.find((chunk) => chunk.similarity !== null);
    expect(best?.similarity ?? 0).toBeGreaterThan(0.8);
  });
});
