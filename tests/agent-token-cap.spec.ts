import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { ALICE, ORG_A, asUser, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// D-52: over the daily token budget — summed from llm_calls input+output
// tokens for today, UTC — /api/agent/chat answers 402, before any model call.
// This is the guard the cost cap cannot be: a free-tier model records
// cost_cents 0 while it still burns the provider's quota, so the only defence
// against a tester exhausting a free tier is counting tokens, not cents.
//
// The route test needs a configured provider (the budget gate runs after the
// 503 no-provider check, by design), so it skips in CI; the mechanism itself
// is asserted without a model in the rolled-back SQL control at the bottom.

const CAP = Number(process.env.AGENT_DAILY_TOKEN_CAP ?? 200_000);

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});

/** Mirrors the provider-configured branch from tests/agent-rate-limit.spec.ts. */
function providerConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined),
  );
}

test.describe("the chat route daily token cap (D-52)", () => {
  test("over the token cap the route answers 402 with retry_after naming the reset", async ({
    context,
    request,
  }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    const corr = "token-cap-" + Date.now();
    const inserted = await sql<{ id: number }[]>`
      insert into llm_calls (
        org_id, correlation_id, step_no, model, prompt_version,
        input_tokens, output_tokens, cost_cents, latency_ms, outcome
      ) values (
        ${ORG_A}, ${corr}, 0, 'openai/gpt-oss-20b', 'v0',
        ${CAP}, 0, 0, 1, 'ok'
      ) returning id`;
    const ids = inserted.map((row) => row.id);
    try {
      await signInBrowser(context, request, apiUrl, "alice@acme.test");
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what are our payment terms?" },
      });

      expect(res.status()).toBe(402);
      const body = await res.json();
      expect(body.error).toContain("token budget");
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      const resetAt = new Date(body.resets_at).getTime();
      expect(Number.isFinite(resetAt)).toBe(true);
      expect(resetAt).toBeGreaterThan(Date.now());
      expect(resetAt).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
      expect(body.correlation_id).toBeTruthy();
    } finally {
      await sql`delete from llm_calls where id = any(${ids})`;
    }
  });

  test("over the token cap the same RPC refuses (SQL, no model needed)", async () => {
    // Seed as the owner: llm_calls has no grant to authenticated by design,
    // and the mechanism under test is the SECURITY DEFINER function that reads
    // those rows under auth.uid(). One row at the cap is enough.
    const corr = "token-cap-sql-" + Date.now();
    const inserted = await sql<{ id: number }[]>`
      insert into llm_calls (
        org_id, correlation_id, step_no, model, prompt_version,
        input_tokens, output_tokens, cost_cents, latency_ms, outcome
      ) values (
        ${ORG_A}, ${corr}, 0, 'openai/gpt-oss-20b', 'v0',
        ${CAP}, 0, 0, 1, 'ok'
      ) returning id`;
    const ids = inserted.map((row) => row.id);
    try {
      await asUser(ALICE, async (tx) => {
        const rows = await tx.unsafe(`
          select public.check_agent_budget(
            '${ORG_A}'::uuid, 100000, 1000000, 3600, 1000000000, ${CAP}
          )::text as verdict`);
        const verdict = String(rows[0].verdict);
        expect(verdict).toContain('"allowed": false');
        expect(verdict).toContain("token_cap");
      });
    } finally {
      await sql`delete from llm_calls where id = any(${ids})`;
    }
  });
});
