import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { ALICE, ORG_A, asUser, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// AC-01 / D-18: over the per-user or per-org request limit, /api/agent/chat
// answers 429 with retry_after. The counters live in Postgres (migration
// 20260821100000), not process memory, so this holds across every instance
// of a serverless deployment.
//
// Deterministic by construction: the counter table is seeded to the limit
// for the current window, one request is made (and refused — a refused
// request never increments, so the test cannot extend the wait), and the
// seeded row is removed afterwards. The limits are read from the same env
// the route reads, so a deployment that tunes them still passes.

const USER_LIMIT = Number(process.env.AGENT_USER_RATE_LIMIT ?? 60);
const ORG_LIMIT = Number(process.env.AGENT_ORG_RATE_LIMIT ?? 300);
const WINDOW_SECONDS = Number(process.env.AGENT_RATE_LIMIT_WINDOW_SECONDS ?? 3600);

let apiUrl: string;
let aliceId: string;

test.beforeAll(async () => {
  ({ apiUrl } = localStack());
  [{ id: aliceId }] = await sql<{ id: string }[]>`
    select id from auth.users where email = 'alice@acme.test'`;
});

// The same window the database computes: epoch-seconds sliced by the window
// length, so the seed lands in the window the route will count against.
function currentWindowStart(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
}

async function seedWindow(scope: "user" | "org", scopeId: string, requests: number) {
  await sql`
    insert into agent_request_budget (scope, scope_id, window_start, requests)
    values (${scope}, ${scopeId}, to_timestamp(${currentWindowStart()}), ${requests})
    on conflict (scope, scope_id, window_start) do update set requests = ${requests}`;
}

async function clearWindow(scope: "user" | "org", scopeId: string) {
  await sql`
    delete from agent_request_budget
     where scope = ${scope} and scope_id = ${scopeId}
       and window_start = to_timestamp(${currentWindowStart()})`;
}

/**
 * Whether this environment has a model at all.
 *
 * The route answers 503 before it reaches the budget gate when nothing is
 * configured, and that order is deliberate — a deployment that cannot answer
 * must not spend its users' quota on 503s. So a route-level assertion about
 * 429 is an assertion about a *configured* deployment, and CI holds no key.
 * The mechanism itself is asserted without one, directly against the SQL
 * function, at the bottom of this file.
 */
function providerConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined),
  );
}

test.describe("the chat route request limits (D-18)", () => {
  test("over the per-user limit the route answers 429 with retry_after", async ({
    context,
    request,
  }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before the budget gate, by design",
    );
    await seedWindow("user", aliceId, USER_LIMIT);
    try {
      await signInBrowser(context, request, apiUrl, "alice@acme.test");
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what are our payment terms?" },
      });

      expect(res.status()).toBe(429);
      const body = await res.json();
      expect(body.error).toContain("too many");
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(body.retry_after).toBeGreaterThan(0);
      expect(body.correlation_id).toBeTruthy();
    } finally {
      await clearWindow("user", aliceId);
    }
  });

  test("over the per-org limit the route answers 429 naming the org", async ({
    context,
    request,
  }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before the budget gate, by design",
    );
    await seedWindow("org", ORG_A, ORG_LIMIT);
    try {
      await signInBrowser(context, request, apiUrl, "alice@acme.test");
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what are our payment terms?" },
      });

      expect(res.status()).toBe(429);
      const body = await res.json();
      expect(body.error).toContain("organization");
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(body.resets_at).toBeTruthy();
    } finally {
      await clearWindow("org", ORG_A);
    }
  });

  test("a request under every limit is allowed (SQL control, rolled back)", async () => {
    // The control: with the counters below the limits the same RPC the route
    // calls says allowed. Rolled back, so it leaves no counters behind and
    // never reaches a real model.
    await asUser(ALICE, async (tx) => {
      const rows = await tx.unsafe(`
        select public.check_agent_budget(
          '${ORG_A}'::uuid, ${USER_LIMIT}, ${ORG_LIMIT}, ${WINDOW_SECONDS}, 1000000, 2000000000
        )::text as verdict`);
      expect(String(rows[0].verdict)).toContain('"allowed": true');
    });
  });

  test("over the per-user limit the same RPC refuses (SQL, no model needed)", async () => {
    // The negative path of the mechanism, asserted where no provider is
    // required — so the guardrail is proven in CI too, not only on a machine
    // that happens to hold a key.
    //
    // The counter is seeded as the owner, not as the user: `authenticated`
    // holds no grant on agent_request_budget at all — the SECURITY DEFINER
    // function is the only thing that may touch it, which is the guarantee
    // being relied on here rather than an inconvenience.
    await seedWindow("user", aliceId, USER_LIMIT);
    try {
      await asUser(ALICE, async (tx) => {
        const rows = await tx.unsafe(
          "select public.check_agent_budget('" +
            ORG_A +
            "'::uuid, " +
            USER_LIMIT +
            ", " +
            ORG_LIMIT +
            ", " +
            WINDOW_SECONDS +
            ", 1000000, 2000000000)::text as verdict",
        );
        const verdict = String(rows[0].verdict);
        expect(verdict).toContain('"allowed": false');
        expect(verdict).toContain("user");
      });
    } finally {
      await clearWindow("user", aliceId);
    }
  });
});
