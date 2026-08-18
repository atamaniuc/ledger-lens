import { execFileSync } from "node:child_process";

// The local stack's own URLs and keys, read from the running stack rather
// than committed. They are fixed, publicly documented development values —
// not secrets — but reading them means a spec cannot pass against a stack
// that has moved to different ports or rotated its demo keys.

export interface LocalStack {
  apiUrl: string;
  functionsUrl: string;
  anonKey: string;
}

let cached: LocalStack | undefined;

export function localStack(): LocalStack {
  if (cached) return cached;

  let status: Record<string, string>;
  try {
    status = JSON.parse(
      execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }),
    );
  } catch (err) {
    throw new Error(
      `could not read the local Supabase stack (\`supabase status\`) — is it running? Try \`task dev-up\`. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Named individually rather than spread: the point of reading the running
  // stack is to fail when it has moved, and an absent key would otherwise
  // travel as `undefined` into a URL and fail as a 404 somewhere else.
  const required = (key: string, value: string | undefined): string => {
    if (!value) {
      throw new Error(
        `\`supabase status\` did not report ${key} — the CLI's output has changed shape.`,
      );
    }
    return value;
  };

  cached = {
    apiUrl: required("API_URL", status.API_URL),
    functionsUrl: required("FUNCTIONS_URL", status.FUNCTIONS_URL),
    anonKey: required("ANON_KEY", process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY),
  };
  return cached;
}

/** The shared secret the provider-webhook function checks on every call. */
export function webhookSecret(): string {
  const s = process.env.WEBHOOK_SHARED_SECRET;
  if (!s) throw new Error("WEBHOOK_SHARED_SECRET missing from .env.local");
  return s;
}
