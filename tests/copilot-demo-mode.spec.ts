import { expect, test } from "@playwright/test";
import { signInBrowser } from "./helpers/auth";
import { localStack } from "./helpers/stack";

// D-53: demo mode makes the copilot ALWAYS answer — deterministically, from
// this tenant's real data, with no model call — so a presentation never ends
// on "try again later". This runs with zero provider keys, which is exactly
// the situation it exists for.
//
// Alice is an admin of Acme, so she can flip the setting through the admin
// API; the chat route then serves the demo answer path.

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});

test.describe("copilot demo mode (D-53)", () => {
  test("with demo mode on, the copilot answers without any provider", async ({
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    const save = await context.request.put("/api/admin/copilot-settings", {
      data: { guardsEnabled: true, demoMode: true, providers: [] },
    });
    expect(save.status(), await save.text()).toBe(200);

    try {
      const res = await context.request.post("/api/agent/chat", {
        data: { question: "what is our total revenue?" },
      });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.demo).toBe(true);
      expect(body.answer).toContain("Demo answer");
      expect(body.correlation_id).toBeTruthy();
    } finally {
      await context.request.put("/api/admin/copilot-settings", {
        data: { guardsEnabled: true, demoMode: false, providers: [] },
      });
    }
  });
});
