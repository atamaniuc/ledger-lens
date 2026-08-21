import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { localStack } from "./helpers/stack";

// ADR 0010 (lane W3-I): the failover-chain route, asserted over HTTP.
//
// The chain's failure modes are unit-tested against stubbed clients in
// src/features/agent/providers/chain.test.ts. What only a running app can
// show is that the route still keeps its contract when the deployment has no
// keys at all — answering or reporting the unconfigured 503 exactly as it
// did before the chain existed — and that a configured 200 names the
// provider that actually answered.

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});

test.describe("Stage 5 — the failover chain route (ADR 0010)", () => {
  test("answers, or reports 503 when no provider keys are configured, as before", async ({
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    // The same environment probe the pre-0010 route spec uses: this asserts
    // the state of *this* environment as much as the code.
    const configured =
      process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined);

    const res = await context.request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?" },
    });

    if (configured) {
      // A configured deployment legitimately answers 200, refuses with 429
      // when the chain is spent, or refuses with 402 when the daily token
      // budget is exhausted first (D-52) — the guard runs before the chain.
      expect([200, 429, 402], await res.text()).toContain(res.status());
      const body = await res.json();
      expect(body.correlation_id).toBeTruthy();

      if (res.status() === 200) {
        expect(typeof body.answer).toBe("string");
        // ADR 0010: the response names the provider and model that answered,
        // and whether the turn fell back off the preferred one.
        expect(typeof body.provider).toBe("string");
        expect(typeof body.model).toBe("string");
        expect(typeof body.fallback).toBe("boolean");
      } else {
        // Either shape of 429 is correct here, and both must carry
        // operator-facing detail: a provider's own rate-limit message, or the
        // chain's "every provider failed" naming the chain it tried. A 402
        // budget refusal is the same class of answer. What is not acceptable
        // is a refusal with nothing to act on.
        expect(body.detail ?? body.error, JSON.stringify(body)).toMatch(/rate limit|failover chain|budget/i);
      }
    } else {
      expect(res.status()).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("not configured");
      expect(body.detail).toContain("ANTHROPIC_API_KEY");
      expect(body.detail).toContain("GROQ_API_KEY");
    }
  });
});
