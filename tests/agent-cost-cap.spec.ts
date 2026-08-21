import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { ALICE, ORG_A, asUser, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// AC-02 / D-18: over the daily cost cap — derived from llm_calls.cost_cents
// for today, UTC — /api/agent/chat answers 402 with retry_after naming when
// the window resets. Deterministic: spend rows are inserted for today, the
// request is refused before any model call, and the rows are removed
// afterwards. A refused request never spends, so the test cannot push the
// org further over the line it is proving.

const CAP = Number(process.env.AGENT_DAILY_COST_CAP_CENTS ?? 1000);

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});


/** See tests/agent-rate-limit.spec.ts: the route answers 503 before the budget
 * gate and before any model call when nothing is configured, and CI holds no
 * key — so a route-level assertion here is about a configured deployment. */
function providerConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined),
  );
}

test.describe("the chat route daily cost cap (D-18)", () => {
  test("over the daily cap the route answers 402 with retry_after naming the reset", async ({
    context,
    request,
  }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    // One row at the cap is enough: the check is spend >= cap, and the cap
    // may already have been partly spent by real turns today.
    const inserted = await sql<{ id: number }[]>`
      insert into llm_calls (
        org_id, correlation_id, step_no, model, prompt_version,
        input_tokens, output_tokens, cost_cents, latency_ms, outcome
      ) values (
        ${ORG_A}, ${`cost-cap-${Date.now()}`}, 0, 'claude-opus-5', 'v0',
        1, 1, ${CAP}, 1, 'ok'
      ) returning id`;
    const ids = inserted.map((row) => row.id);
    try {
      await signInBrowser(context, request, apiUrl, "alice@acme.test");
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what are our payment terms?" },
      });

      expect(res.status()).toBe(402);
      const body = await res.json();
      expect(body.error).toContain("budget");
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      // The 402 names when the window resets — the next UTC midnight.
      expect(body.resets_at).toBeTruthy();
      const resetAt = new Date(body.resets_at).getTime();
      expect(Number.isFinite(resetAt)).toBe(true);
      expect(resetAt).toBeGreaterThan(Date.now());
      expect(resetAt).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
      expect(body.correlation_id).toBeTruthy();
    } finally {
      await sql`delete from llm_calls where id = any(${ids})`;
    }
  });

  test("under the cap the same RPC allows the request (SQL control, rolled back)", async () => {
    // A cap far above any real spend proves the allowed path of the same
    // function the route calls, without touching a model.
    await asUser(ALICE, async (tx) => {
      const rows = await tx.unsafe(`
        select public.check_agent_budget(
          '${ORG_A}'::uuid, 100000, 1000000, 3600, 1000000000
        )::text as verdict`);
      expect(String(rows[0].verdict)).toContain('"allowed": true');
    });
  });
});
