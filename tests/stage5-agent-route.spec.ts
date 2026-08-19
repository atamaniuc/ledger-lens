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
    // no ANTHROPIC_API_KEY set, the route answers 503 with an operator-facing
    // message rather than a 500 from the SDK's constructor. When a key is
    // configured the same call reaches the model, so the assertion follows
    // the environment rather than pretending it does not exist.
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const res = await context.request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?" },
    });

    if (process.env.ANTHROPIC_API_KEY) {
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.correlation_id).toBeTruthy();
      expect(typeof body.answer).toBe("string");
    } else {
      expect(res.status()).toBe(503);
      expect((await res.json()).error).toContain("not configured");
    }
  });
});
