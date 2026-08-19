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
import { ModelError } from "../lib/agent/providers/types";
import { TOOLS } from "../lib/agent/tools";
import { searchChunks } from "../lib/rag/search";
import type { Database } from "../lib/supabase/database.types";

const HERE = import.meta.dirname;
const VERBOSE = process.argv.includes("--verbose");

/** Longer than this and the run is waiting, not measuring. */
const MAX_BACKOFF_MS = 45_000;
/**
 * A free tier's token budget refills over a rolling minute, and the wait it
 * suggests is optimistic — other requests refill the window meanwhile. Five
 * tries with a floor under the suggested wait is what it took for Groq's
 * 8,000 TPM to get through five agent cases; three was not enough.
 */
/**
 * Tokens per minute to stay under, from `EVALS_TPM`; 0 disables the pacing.
 *
 * Reacting to 429s is not enough on a free tier. A turn here costs 2–5k
 * tokens and Groq's free limit is 8,000 per rolling minute, so a run that
 * only backs off after being refused spends its retries being refused again —
 * measured: one case of seven scored. The default matches the tier this
 * project is documented against; a paid account should raise it.
 */
const TPM_BUDGET = Number(process.env.EVALS_TPM ?? 8_000);

const MAX_ATTEMPTS = 5;
const MIN_BACKOFF_MS = 6_000;

interface Case {
  id: string;
  type: "retrieval" | "unanswerable" | "injection" | "metric" | "lookup";
  user: string;
  query: string;
  expect_document?: string;
  expect_tool?: string;
  /** A compound question needs a tool for each half, not one and a guess. */
  also_expect_tool?: string;
  /** The question named no filter, so the tool call must not invent one. */
  expect_no_filter?: boolean;
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
  /** Cases that actually ran. A case that never reached the model is not a miss. */
  total: number;
  threshold: number;
  skipped?: string;
  /**
   * Cases that could not be attempted — a rate limit, a transport failure.
   * Kept out of the score, because a metric that goes red on infrastructure
   * is a gate people learn to override. Counted separately, because a run
   * that did not measure everything is not a pass either.
   */
  unscored?: number;
}

const failures: string[] = [];

// A rolling one-minute window of what has been spent, so the runner can wait
// *before* a call it knows will be refused rather than after.
const spent: { at: number; tokens: number }[] = [];

function spentLastMinute(): number {
  const cutoff = Date.now() - 60_000;
  while (spent.length > 0 && spent[0].at < cutoff) spent.shift();
  return spent.reduce((sum, entry) => sum + entry.tokens, 0);
}

async function waitForBudget(estimate: number): Promise<void> {
  if (TPM_BUDGET <= 0) return;

  while (spentLastMinute() + estimate > TPM_BUDGET && spent.length > 0) {
    // Wait for the oldest entry to age out of the window, plus a moment.
    const wait = Math.max(1_000, spent[0].at + 60_000 - Date.now() + 500);
    console.log(
      `  pacing: ${spentLastMinute()} of ${TPM_BUDGET} tokens used this minute, waiting ${(
        wait / 1000
      ).toFixed(0)}s`,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

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

  // Imported lazily so the deterministic tier does not pay for a model SDK.
  const [{ createModelClient }, { runAgentTurn }] = await Promise.all([
    import("../lib/agent/providers"),
    import("../lib/agent/loop"),
  ]);

  const model = createModelClient();
  if (!model) {
    const skipped = "no model provider configured";
    return [
      { name: "tool choice", passed: 0, total: subset.length, threshold: 1, skipped },
      { name: "citation validity", passed: 0, total: 0, threshold: thresholds.citation_validity, skipped },
    ];
  }
  console.log(`  model: ${model.provider}/${model.model}\n`);

  let correctTool = 0;
  let verified = 0;
  let answered = 0;
  let unscored = 0;
  let estimate = 4_000;

  for (const testCase of subset) {
    const supabase = await clientFor(testCase.user);
    const { data: membership } = await supabase.from("memberships").select("org_id").limit(1).single();

    // A free tier is rate-limited by tokens per minute, and this agent's
    // system prompt plus four tool schemas is most of a minute's budget. One
    // case hitting the limit must not abort the run: the case is scored as a
    // miss with its reason, and the runner waits when the provider says to.
    let result: Awaited<ReturnType<typeof runAgentTurn>> | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && result === null; attempt++) {
      await waitForBudget(estimate);
      try {
        result = await runAgentTurn({
          question: testCase.query,
          orgId: membership!.org_id,
          correlationId: `eval-${testCase.id}`,
          supabase,
          model,
        });
      } catch (error) {
        const suggested = error instanceof ModelError ? error.retryAfterMs : undefined;
        const wait = suggested === undefined ? undefined : Math.max(suggested, MIN_BACKOFF_MS);
        if (attempt < MAX_ATTEMPTS - 1 && wait !== undefined && wait <= MAX_BACKOFF_MS) {
          console.log(`  ${testCase.id}: rate-limited, waiting ${(wait / 1000).toFixed(1)}s`);
          await new Promise((resolve) => setTimeout(resolve, wait + 500));
          continue;
        }
        note(testCase.id, error instanceof Error ? error.message : String(error));
        break;
      }
    }

    if (result === null) {
      unscored++;
      continue;
    }

    const used = result.usage.inputTokens + result.usage.outputTokens;
    spent.push({ at: Date.now(), tokens: used });
    // The next case is likely to cost what this one did, and a first guess
    // that is too low only costs one 429 before it corrects itself.
    estimate = Math.max(estimate, used);

    const wanted = [testCase.expect_tool, testCase.also_expect_tool].filter(
      (name): name is string => typeof name === "string",
    );
    const missing = wanted.filter((name) => !result.toolsUsed.includes(name));

    if (missing.length === 0) correctTool++;
    else note(testCase.id, `expected [${wanted.join(", ")}], used [${result.toolsUsed.join(", ")}]`);

    answered++;
    if (result.verified) verified++;
    else note(testCase.id, `unverified citations: ${JSON.stringify(result.citations)}`);

    if (VERBOSE) console.log(`  ${testCase.id} → ${result.answer.replace(/\n/g, " ").slice(0, 220)}`);
  }

  return [
    { name: "tool choice", passed: correctTool, total: answered, threshold: 1, unscored },
    {
      name: "citation validity",
      passed: verified,
      total: answered,
      threshold: thresholds.citation_validity,
      unscored,
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
let incomplete = false;

for (const score of scores) {
  const rate = score.total === 0 ? 0 : score.passed / score.total;
  const fraction = `${score.passed}/${score.total}`.padEnd(6);
  let verdict: string;

  if (score.skipped) {
    verdict = `skip (${score.skipped})`;
  } else if (score.total === 0) {
    // Nothing ran. Reported as its own thing rather than 0/0 = pass, which
    // is the worst possible reading of an absent measurement.
    verdict = "NOT MEASURED";
    incomplete = true;
  } else if (rate < score.threshold) {
    verdict = "FAIL";
    breached = true;
  } else if (score.unscored) {
    verdict = `pass (${score.unscored} unscored)`;
    incomplete = true;
  } else {
    verdict = "pass";
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

if (incomplete) {
  console.log(
    "\n  Some cases never reached the model — usually a free tier's rate limit.\n" +
      "  Scored over the cases that ran, and the run still exits non-zero: a\n" +
      "  measurement that did not happen is not a measurement that passed.",
  );
}

console.log(`\n  ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
process.exit(breached || incomplete ? 1 : 0);
