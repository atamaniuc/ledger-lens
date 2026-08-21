import { expect, test } from "@playwright/test";
import { localStack } from "./helpers/stack";

// Sign-up is closed (D-20). The project is a two-tenant demonstration over
// financial data, and an account that created itself belongs to no
// organisation — so every RLS claim would be made about a user nobody
// vouched for. An operator creates accounts; this asserts the door, and that
// closing it did not lock out the tenants the rest of the suite depends on.

test.describe("registration is closed", () => {
  test("an anonymous caller cannot create an account", async ({ request }) => {
    const { apiUrl, anonKey } = localStack();
    const res = await request.post(`${apiUrl}/auth/v1/signup`, {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email: `intruder-${Date.now()}@example.test`, password: "password123" },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).not.toBe(200);
    expect(JSON.stringify(await res.json())).toMatch(/signup|disabled|not allowed/i);
  });

  test("a magic link for an unknown address does not quietly create one", async ({ request }) => {
    const { apiUrl, anonKey } = localStack();
    const res = await request.post(`${apiUrl}/auth/v1/otp`, {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email: `unknown-${Date.now()}@example.test`, create_user: false },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).not.toBe(200);
  });

  test("the seeded users can still sign in", async ({ request }) => {
    const { apiUrl, anonKey } = localStack();
    const res = await request.post(`${apiUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email: "bob@globex.test", password: "password123" },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
  });
});
