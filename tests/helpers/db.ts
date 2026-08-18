import postgres from "postgres";

// Direct SQL, for the assertions HTTP cannot make: privilege grants, RLS
// under a real role, and the "what if this went wrong" mutations that have
// to be rolled back.

const DB_URL =
  process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// These helpers mutate and truncate. They may only ever talk to a database
// on this machine. The host is parsed and matched exactly rather than
// searched for as a substring: `postgres://u:p@db.example.com/x?o=127.0.0.1`
// would pass a substring test, and so would the host
// `127.0.0.1.attacker.example`.
function assertLoopback(url: string): void {
  const scheme = /^postgres(ql)?:\/\//.exec(url);
  if (!scheme) {
    throw new Error(`DB_URL is not a postgres:// URL, refusing to touch it: ${url}`);
  }
  const authority = url.slice(scheme[0].length).split("/")[0].split("?")[0];
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostPort.startsWith("[")
    ? hostPort.slice(1, hostPort.indexOf("]"))
    : hostPort.split(":")[0];
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `DB_URL host '${host}' is not loopback. These tests truncate tables and are for the local stack only.`,
    );
  }
}
assertLoopback(DB_URL);

export const sql = postgres(DB_URL, { onnotice: () => {} });

/** Fixed by supabase/seed.sql so specs can name tenants instead of finding them. */
export const ORG_A = "00000000-0000-4000-8000-000000000001"; // Acme Corp
export const ORG_B = "00000000-0000-4000-8000-000000000002"; // Globex Inc
export const ALICE = "00000000-0000-4000-9000-000000000001"; // member of Acme
export const BOB = "00000000-0000-4000-9000-000000000002"; // member of Globex only

class Rollback extends Error {}

/**
 * Runs `body` inside a transaction that is always rolled back.
 *
 * Asserting that a check *can* go red matters as much as asserting it goes
 * green — a check that cannot fail is decoration — but the mutations that
 * prove it must not survive into the next test.
 */
export async function whatIf<T>(
  body: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let captured: T;
  try {
    await sql.begin(async (tx) => {
      captured = await body(tx);
      // The only way out: postgres.js rolls back when the callback throws.
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return captured!;
}

/**
 * Runs a query as a real end user — the `authenticated` role carrying a JWT
 * claim, which is what PostgREST sets up and what every RLS policy reads via
 * auth.uid(). Rolled back, since `set local` needs a transaction anyway.
 */
export async function asUser<T>(
  userId: string,
  body: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return whatIf(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx.unsafe(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" })}'`,
    );
    return body(tx);
  });
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
