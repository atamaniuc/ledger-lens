import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { ORG_B, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 5, Batch H: the chat route's guard rails, asserted over HTTP.
//
// The loop's own terminations are unit-tested against a stubbed model. What
// only a running app can show is the order of the gates in front of it: who
// is refused, what a malformed body does, and what happens when the
// deployment has no model credential — none of which should ever reach the
// Anthropic SDK.

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});

test.describe("Stage 5 — the chat route", () => {
  test("refuses an unauthenticated caller before reading the body", async ({ request }) => {
    const res = await request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?" },
    });
    expect(res.status()).toBe(401);
  });

  test("a malformed body from a stranger is still just unauthorized", async ({ request }) => {
    // Auth first, validation second: an anonymous caller must not be able to
    // tell a well-formed request from a malformed one.
    const res = await request.post("/api/agent/chat", { data: {} });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a signed-in user with no question gets a 400", async ({ context, request }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const res = await context.request.post("/api/agent/chat", { data: { question: "   " } });
    expect(res.status()).toBe(400);
  });

  test("a question longer than the cap is refused, not truncated", async ({
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const res = await context.request.post("/api/agent/chat", {
      data: { question: "x".repeat(1_001) },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("1000");
  });

  test("a correlation_id that is not a string is replaced, not passed through", async ({
    context,
    request,
  }) => {
    // From the reviewer pass: `body.correlation_id` is whatever JSON the
    // caller sent. An object reached `log_llm_call`, whose column is `text`,
    // and came back as a 500 on every request from that client. It is also
    // the caller picking a chain id, which is how one tenant's requests get
    // to shadow another's in the logs.
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const res = await context.request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?", correlation_id: { not: "a string" } },
    });

    // Whatever the environment does next, it must not be a 500 caused by the
    // id, and the id that comes back must be a usable one.
    expect(res.status()).not.toBe(500);
    const body = await res.json();
    if (body.correlation_id) expect(typeof body.correlation_id).toBe("string");
  });

  test("an account in two organizations is refused rather than silently scoped to one", async ({
    context,
    request,
  }) => {
    // The tools carry no org_id filter — RLS decides — so a second membership
    // widens what the answer is built from while the audit rows keep naming
    // one org. Refusing is the honest answer until org selection exists.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      select id from auth.users where email = 'alice@acme.test'`;
    await sql`insert into memberships (user_id, org_id, role)
              values (${userId}, ${ORG_B}, 'member')
              on conflict do nothing`;
    try {
      await signInBrowser(context, request, apiUrl, "alice@acme.test");
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what are our payment terms?" },
      });

      expect(res.status()).toBe(409);
      expect((await res.json()).error).toContain("more than one organization");
    } finally {
      await sql`delete from memberships where user_id = ${userId} and org_id = ${ORG_B}`;
    }
  });

  test("an unconfigured deployment says so instead of failing inside the SDK", async ({
    context,
    request,
  }) => {
    // This asserts the state of *this* environment as much as the code: with
    // no provider configured, the route answers 503 with an operator-facing
    // message rather than a 500 from inside a client. When any provider is
    // configured — Anthropic or one of the free OpenAI-compatible tiers — the
    // same call reaches a model, so the assertion follows the environment
    // rather than pretending it does not exist.
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const configured =
      process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined);

    const res = await context.request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?" },
    });

    if (configured) {
      // 429 is a legitimate answer from a configured deployment, not a
      // failure of this code: free tiers run out, and the point of the
      // mapping under test is that the route says which of the two happened
      // rather than collapsing both into a 500.
      expect([200, 429], await res.text()).toContain(res.status());
      const body = await res.json();
      expect(body.correlation_id).toBeTruthy();

      if (res.status() === 200) expect(typeof body.answer).toBe("string");
      // A configured deployment answers, or refuses with detail an operator can
      // act on: a provider rate limit, or the chain reporting that every
      // provider it tried failed (ADR 0010).
      else expect(body.detail, JSON.stringify(body)).toMatch(/rate limit|failover chain/i);
    } else {
      expect(res.status()).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("not configured");
      // The 503 names what is missing. An operator should not have to read
      // the source to find out which variable to set.
      expect(body.detail).toContain("ANTHROPIC_API_KEY");
      expect(body.detail).toContain("GROQ_API_KEY");
    }
  });
});
