import { closeDb } from "./helpers/db";

// The Postgres pool is a module-level singleton shared by every spec, so it
// can only be closed once, after all of them. Closing it in a file's
// afterAll ends the connection for whichever file runs next — which
// surfaced as `write CONNECTION_ENDED` in an unrelated test.
export default async function globalTeardown(): Promise<void> {
  await closeDb();
}
