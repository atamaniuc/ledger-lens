import { expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

// Signing a browser context in, the way the app itself would.
//
// Through the app's own /auth/callback rather than by fabricating cookies, so
// the cookie names, chunking and flags are whatever the running code writes.
// GoTrue's admin `generate_link` produces the token without sending mail,
// which also keeps these specs clear of the local stack's two-emails-per-hour
// send limit. The magic-link flow through a real inbox is covered once, in
// stage4-auth.spec.ts; repeating it per test would only buy flakiness.

export function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  return key;
}

export function adminHeaders(): Record<string, string> {
  const key = serviceRoleKey();
  return { apikey: key, authorization: `Bearer ${key}` };
}

/**
 * Creates a user the way an operator does, now that registration is closed
 * (D-20). The admin API is the only door left, which is the point — but it
 * means a spec that used to rely on self-service sign-up has to ask for the
 * account first.
 */
export async function createUserAsOperator(
  request: APIRequestContext,
  apiUrl: string,
  email: string,
): Promise<void> {
  const res = await request.post(`${apiUrl}/auth/v1/admin/users`, {
    headers: { ...adminHeaders(), "content-type": "application/json" },
    data: { email, email_confirm: true },
    failOnStatusCode: false,
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

export async function signInBrowser(
  context: BrowserContext,
  request: APIRequestContext,
  apiUrl: string,
  email: string,
): Promise<void> {
  const res = await request.post(`${apiUrl}/auth/v1/admin/generate_link`, {
    headers: adminHeaders(),
    data: { type: "magiclink", email },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { hashed_token: tokenHash } = (await res.json()) as { hashed_token: string };

  const page = await context.newPage();
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=magiclink`);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.close();
}
