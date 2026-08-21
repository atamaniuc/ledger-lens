import { expect, test, type BrowserContext } from "@playwright/test";
import {
  MAX_CHUNK_SIZE,
  createChunks,
  stringFromBase64URL,
  stringToBase64URL,
} from "@supabase/ssr";
import { AUTH_COOKIE_NAME } from "@/platform/supabase/config";
import { createUserAsOperator } from "./helpers/auth";
import { localStack } from "./helpers/stack";

// Stage 4, Batch A — the access foundation.
//
// Three things are worth asserting here and nowhere else: that an
// unauthenticated request never reaches the dashboard, that a session whose
// access token has expired is refreshed rather than treated as signed out,
// and that the magic-link flow works end to end through a real inbox.
//
// The refresh case is the one that would otherwise go untested. Local
// `jwt_expiry` is 3600s, so waiting a token out is not a test — the session
// cookie is rewritten with a past expiry instead, which is deterministic and
// takes no wall-clock time.

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const SIGNED_IN_AS = '[data-testid="signed-in-as"]';

let apiUrl: string;
let serviceRoleKey: string;
const createdUserIds: string[] = [];

test.beforeAll(() => {
  ({ apiUrl } = localStack());
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  serviceRoleKey = key;
});

// The magic-link case signs up a throwaway user so concurrent runs cannot
// read each other's mail. Left behind, they accumulate in auth.users forever.
test.afterAll(async ({ request }) => {
  for (const id of createdUserIds) {
    await request.delete(`${apiUrl}/auth/v1/admin/users/${id}`, {
      headers: adminHeaders(),
    });
  }
});

test.describe("Stage 4 — access foundation", () => {
  test("an unauthenticated request for /dashboard is redirected, not rendered", async ({
    request,
  }) => {
    const res = await request.get("/dashboard", { maxRedirects: 0 });

    expect(res.status()).toBe(307);
    const location = res.headers()["location"];
    expect(location).toBeTruthy();
    const target = new URL(location, "http://localhost:3000");
    expect(target.pathname).toBe("/login");
    // The requested path survives the round trip, so signing in lands where
    // the user was going rather than on a generic home page.
    expect(target.searchParams.get("next")).toBe("/dashboard");

    // Nothing of the page leaked into the redirect body.
    expect(await res.text()).not.toContain("Dashboard");
  });

  test("an expired access token is refreshed by the proxy, not treated as signed out", async ({
    page,
    context,
    request,
  }) => {
    await signInAs(context, request, "alice@acme.test");

    await page.goto("/dashboard");
    await expect(page.locator(SIGNED_IN_AS)).toHaveText("alice@acme.test");

    const before = await readSession(context);
    expect(before.refresh_token).toEqual(expect.any(String));

    // Past expiry, valid refresh token: exactly the state a tab left open
    // over lunch is in. auth-js decides to refresh from `expires_at`, so
    // rewriting it is enough — and the access token is left intact on
    // purpose, because the assertion below is that it *changed*.
    await writeSession(context, {
      ...before,
      expires_in: 0,
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });

    await page.goto("/dashboard");
    await expect(page.locator(SIGNED_IN_AS)).toHaveText("alice@acme.test");

    const after = await readSession(context);
    // A rotated token is the proof. Had the proxy not refreshed, the page
    // would either have redirected to /login or rendered with the same
    // token, and both look identical from the DOM alone.
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("the magic-link round trip completes through Mailpit", async ({
    page,
    request,
  }) => {
    // Unique per run: Mailpit is shared, and a search by recipient is the
    // only way two runs cannot read each other's message.
    const email = `stage4-${Date.now()}@ledgerlens.test`;

    // Registration is closed (D-20), so the account has to exist before a link
    // can be asked for. That is the flow being tested now: an operator invites,
    // the invited address signs in. A self-service sign-up is asserted to fail
    // in tests/auth-signup-closed.spec.ts.
    await createUserAsOperator(request, localStack().apiUrl, email);

    await page.goto("/login");
    await page.getByLabel("Work email").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();

    const sent = page.locator('[data-testid="login-sent"]');
    const failed = page.locator('[data-testid="login-error"]');
    await expect(sent.or(failed)).toBeVisible();

    if (await failed.isVisible()) {
      const message = (await failed.textContent()) ?? "";
      // `[auth.rate_limit] email_sent` is 2 per hour on the local stack.
      // Skipping says so out loud rather than reporting a product failure.
      test.skip(
        /rate limit|too many/i.test(message),
        `local stack refused to send: ${message}`,
      );
      throw new Error(`sign-in request failed: ${message}`);
    }

    const link = await magicLinkFor(request, email);
    await page.goto(link);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator(SIGNED_IN_AS)).toHaveText(email);

    // A user created by this flow belongs to no org. RLS returns zero rows
    // for them, which the dashboard must render as an empty list and not as
    // an error — the cross-tenant Definition-of-Done check expects the same
    // shape, so a failure here would also be a failure there.
    await expect(page.locator('[data-testid="orgs-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="orgs"] li')).toHaveCount(0);

    createdUserIds.push(await userIdFor(request, email));
  });
});

function adminHeaders() {
  return { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` };
}

/**
 * Signs in through the app's own callback rather than by fabricating
 * cookies, so the cookie names, chunking and flags are whatever the running
 * code actually writes. GoTrue's admin `generate_link` gives a token without
 * sending mail, which also keeps this test clear of the send rate limit.
 */
async function signInAs(
  context: BrowserContext,
  request: import("@playwright/test").APIRequestContext,
  email: string,
) {
  const res = await request.post(`${apiUrl}/auth/v1/admin/generate_link`, {
    headers: adminHeaders(),
    data: { type: "magiclink", email },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { hashed_token: tokenHash } = (await res.json()) as {
    hashed_token: string;
  };

  const page = await context.newPage();
  await page.goto(`/auth/callback?token_hash=${tokenHash}&type=magiclink`);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.close();
}

async function magicLinkFor(
  request: import("@playwright/test").APIRequestContext,
  email: string,
): Promise<string> {
  const search = await request.get(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
  );
  expect(search.status(), await search.text()).toBe(200);
  const { messages } = (await search.json()) as { messages: { ID: string }[] };
  expect(messages.length, `no message for ${email} in Mailpit`).toBeGreaterThan(0);

  const body = await request.get(`${MAILPIT}/api/v1/message/${messages[0].ID}`);
  const { Text, HTML } = (await body.json()) as { Text: string; HTML: string };
  const match = /https?:\/\/[^\s"'<>]*\/auth\/v1\/verify[^\s"'<>]*/.exec(
    `${Text}\n${HTML}`,
  );
  if (!match) throw new Error("no verify link in the message body");
  // Mailpit stores the entity-encoded HTML form; the query separators have
  // to come back before the URL means what it says.
  return match[0].replaceAll("&amp;", "&");
}

async function userIdFor(
  request: import("@playwright/test").APIRequestContext,
  email: string,
): Promise<string> {
  const res = await request.get(
    `${apiUrl}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: adminHeaders() },
  );
  const { users } = (await res.json()) as { users: { id: string }[] };
  expect(users.length, `no auth user for ${email}`).toBeGreaterThan(0);
  return users[0].id;
}

interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  [key: string]: unknown;
}

/** The session as @supabase/ssr stores it: base64url JSON, possibly chunked. */
async function readSession(context: BrowserContext): Promise<StoredSession> {
  const chunks = (await context.cookies())
    .filter((c) => c.name === AUTH_COOKIE_NAME || c.name.startsWith(`${AUTH_COOKIE_NAME}.`))
    .sort((a, b) => chunkIndex(a.name) - chunkIndex(b.name));

  expect(chunks.length, `no ${AUTH_COOKIE_NAME} cookie was set`).toBeGreaterThan(0);

  const raw = chunks.map((c) => c.value).join("");
  const json = raw.startsWith("base64-")
    ? stringFromBase64URL(raw.slice("base64-".length))
    : decodeURIComponent(raw);
  return JSON.parse(json) as StoredSession;
}

async function writeSession(context: BrowserContext, session: StoredSession) {
  const existing = (await context.cookies()).filter(
    (c) => c.name === AUTH_COOKIE_NAME || c.name.startsWith(`${AUTH_COOKIE_NAME}.`),
  );
  const template = existing[0];
  expect(template, `no ${AUTH_COOKIE_NAME} cookie to rewrite`).toBeTruthy();

  const value = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  const chunks = createChunks(AUTH_COOKIE_NAME, value, MAX_CHUNK_SIZE);

  // Clearing first: a rewrite that produces fewer chunks than it replaces
  // would otherwise leave a stale `.1` behind, and the combined value would
  // decode to nothing readable — the exact corruption @supabase/ssr warns
  // about, arrived at from the test side.
  await context.clearCookies({ name: new RegExp(`^${AUTH_COOKIE_NAME}(\\.\\d+)?$`) });
  await context.addCookies(
    chunks.map((chunk) => ({
      name: chunk.name,
      value: chunk.value,
      domain: template.domain,
      path: template.path,
      httpOnly: template.httpOnly,
      secure: template.secure,
      sameSite: template.sameSite,
    })),
  );
}

function chunkIndex(name: string): number {
  const match = /\.(\d+)$/.exec(name);
  return match ? Number(match[1]) : -1;
}
