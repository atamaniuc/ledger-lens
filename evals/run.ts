// The Stage 6 regression gate.
//
// Scores the retrieval and safety behaviour Stage 5 shipped against a fixed
// dataset, prints a table, and exits non-zero when a threshold is breached.
// `task evals` runs exactly this, and so does CI — there is one command, so
// there is no "works locally, fails in CI".
//
// Two tiers, stated rather than blurred:
//
//   * Deterministic (always runs). Retrieval recall, whether an unanswerable
//     question retrieves nothing, and whether the injection fixture is
//     reachable while the tool it asks for does not exist. None of this needs
//     a model, so none of it can be flaky because a model had an off day.
//   * Model-dependent (needs ANTHROPIC_API_KEY). Whether the agent picks the
//     right tool and whether its citations verify. Skipped and *reported as
//     skipped* when there is no key — never silently counted as a pass.
//
// Usage: bun run evals/run.ts [--verbose]

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TOOLS } from "../lib/agent/tools";
import { searchChunks } from "../lib/rag/search";
import type { Database } from "../lib/supabase/database.types";

const HERE = import.meta.dirname;
const VERBOSE = process.argv.includes("--verbose");

interface Case {
  id: string;
  type: "retrieval" | "unanswerable" | "injection" | "metric" | "lookup";
  user: string;
  query: string;
  expect_document?: string;
  expect_tool?: string;
  forbidden_tool?: string;
}

interface Thresholds {
  version: string;
  recall_at_5: number;
  abstention_rate: number;
  injection_safety: number;
  citation_validity: number;
}

const cases: Case[] = readFileSync(join(HERE, "dataset.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Case);

const thresholds: Thresholds = JSON.parse(
  readFileSync(join(HERE, "thresholds.json"), "utf8"),
);

// The local stack's own URL and anon key, read from the running stack rather
// than committed — the same reason tests/helpers/stack.ts does it.
const status: Record<string, string> = JSON.parse(
  execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }),
);
const apiUrl = status.API_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY;

const clients = new Map<string, SupabaseClient<Database>>();

async function clientFor(email: string): Promise<SupabaseClient<Database>> {
  const existing = clients.get(email);
  if (existing) return existing;

  const supabase = createClient<Database>(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: "password123",
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);

  // Every query below goes through this client, so RLS is the only thing
  // deciding what a case can see. A case written for Acme cannot accidentally
  // score against Globex's corpus.
  clients.set(email, supabase);
  return supabase;
}

interface Score {
  name: string;
  passed: number;
  total: number;
  threshold: number;
  skipped?: string;
}

const failures: string[] = [];

function note(id: string, message: string): void {
  failures.push(`${id}: ${message}`);
}

async function scoreRetrieval(): Promise<Score> {
  const subset = cases.filter((c) => c.type === "retrieval");
  let hits = 0;

  for (const testCase of subset) {
    const supabase = await clientFor(testCase.user);
    const chunks = await searchChunks(supabase, testCase.query);
    const titles = chunks.map((chunk) => chunk.document_title);

    if (titles.includes(testCase.expect_document ?? "")) hits++;
    else note(testCase.id, `expected "${testCase.expect_document}", got [${titles.join(", ")}]`);

    if (VERBOSE) console.log(`  ${testCase.id} ${titles.length} chunks: ${titles.join(" | ")}`);
  }

  return { name: "recall@5", passed: hits, total: subset.length, threshold: thresholds.recall_at_5 };
}

async function scoreUnanswerable(): Promise<Score> {
  // Retrieval returning nothing is what makes abstention reachable at all.
  // Without the relevance floor a nearest-neighbour search always returns
  // neighbours, so this metric would have been unscoreable before Stage 5's
  // migration 20260819200000 — which is why it is measured here directly.
  const subset = cases.filter((c) => c.type === "unanswerable");
  let correct = 0;

  for (const testCase of subset) {
    const supabase = await clientFor(testCase.user);
    const chunks = await searchChunks(supabase, testCase.query);

    if (chunks.length === 0) correct++;
    else note(testCase.id, `retrieved ${chunks.length} chunks for an unanswerable question`);
  }

  return {
    name: "abstention",
    passed: correct,
    total: subset.length,
    threshold: thresholds.abstention_rate,
  };
}

async function scoreInjection(): Promise<Score> {
  // Two conditions, and both matter. The poisoned document must really be
  // retrieved — a test that quietly stopped retrieving it would pass while
  // proving nothing — and the tool it tries to recruit must not exist.
  const subset = cases.filter((c) => c.type === "injection");
  const toolNames = new Set(TOOLS.map((tool) => tool.name));
  let safe = 0;

  for (const testCase of subset) {
    const supabase = await clientFor(testCase.user);
    const chunks = await searchChunks(supabase, testCase.query);
    const retrieved = chunks.some((chunk) => chunk.document_title === testCase.expect_document);
    const toolExists = toolNames.has(testCase.forbidden_tool ?? "");

    if (retrieved && !toolExists) safe++;
    else if (!retrieved) note(testCase.id, "the injection fixture was not retrieved — this case proves nothing");
    else note(testCase.id, `a tool named ${testCase.forbidden_tool} exists`);
  }

  return {
    name: "injection",
    passed: safe,
    total: subset.length,
    threshold: thresholds.injection_safety,
  };
}

async function scoreAgent(): Promise<Score[]> {
  const subset = cases.filter((c) => c.type === "metric" || c.type === "lookup");

  if (!process.env.ANTHROPIC_API_KEY) {
    const skipped = "no ANTHROPIC_API_KEY";
    return [
      { name: "tool choice", passed: 0, total: subset.length, threshold: 1, skipped },
      { name: "citation validity", passed: 0, total: 0, threshold: thresholds.citation_validity, skipped },
    ];
  }

  // Imported lazily so the deterministic tier does not pay for the SDK.
  const [{ default: Anthropic }, { runAgentTurn }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("../lib/agent/loop"),
  ]);

  let correctTool = 0;
  let verified = 0;
  let answered = 0;

  for (const testCase of subset) {
    const supabase = await clientFor(testCase.user);
    const { data: membership } = await supabase.from("memberships").select("org_id").limit(1).single();

    const result = await runAgentTurn({
      question: testCase.query,
      orgId: membership!.org_id,
      correlationId: `eval-${testCase.id}`,
      supabase,
      anthropic: new Anthropic(),
    });

    if (result.toolsUsed.includes(testCase.expect_tool ?? "")) correctTool++;
    else note(testCase.id, `expected ${testCase.expect_tool}, used [${result.toolsUsed.join(", ")}]`);

    answered++;
    if (result.verified) verified++;
    else note(testCase.id, "the answer cited something that was never retrieved");
  }

  return [
    { name: "tool choice", passed: correctTool, total: subset.length, threshold: 1 },
    {
      name: "citation validity",
      passed: verified,
      total: answered,
      threshold: thresholds.citation_validity,
    },
  ];
}

const startedAt = Date.now();
const scores: Score[] = [
  await scoreRetrieval(),
  await scoreUnanswerable(),
  await scoreInjection(),
  ...(await scoreAgent()),
];

console.log(`\nLedgerLens evals — thresholds ${thresholds.version}, ${cases.length} cases\n`);
console.log("  metric              score        bar     result");
console.log("  ------------------  -----------  ------  ------");

let breached = false;

for (const score of scores) {
  const rate = score.total === 0 ? 0 : score.passed / score.total;
  const fraction = `${score.passed}/${score.total}`.padEnd(6);
  let verdict: string;

  if (score.skipped) {
    verdict = `skip (${score.skipped})`;
  } else if (rate >= score.threshold) {
    verdict = "pass";
  } else {
    verdict = "FAIL";
    breached = true;
  }

  console.log(
    `  ${score.name.padEnd(18)}  ${rate.toFixed(2)} ${fraction}  ${score.threshold
      .toFixed(2)
      .padEnd(6)}  ${verdict}`,
  );
}

if (failures.length > 0) {
  console.log("\n  cases that did not score:");
  for (const failure of failures) console.log(`    ${failure}`);
}

console.log(`\n  ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
process.exit(breached ? 1 : 0);
