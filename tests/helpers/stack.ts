import { execFileSync } from "node:child_process";

// The local stack's own URLs and keys. They are fixed, publicly documented
// development values — not secrets — but a spec must not pass against a stack
// that has moved to different ports or rotated its demo keys.
//
// Two sources, in this order, and the order is the fix for D-46:
//   1. the environment `playwright.config.ts` already loaded from .env.local,
//      which `task env` writes from the running stack;
//   2. `supabase status` as a fallback, run with DO_NOT_TRACK=1.
//
// The CLI used to be the only source, and it is not reliable enough to be one:
// `supabase status` intermittently dies writing its telemetry file
// (`PlatformError` on ~/.supabase/telemetry.json.tmp) while all twelve
// containers are healthy. Every spec that called this helper failed at
// startup, which took the whole suite down — 10 failed, 54 never ran — and the
// failure said "is it running?" about a stack that was running.

export interface LocalStack {
  apiUrl: string;
  functionsUrl: string;
  anonKey: string;
}

let cached: LocalStack | undefined;

function fromEnvironment(): LocalStack | undefined {
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!apiUrl || !anonKey) return undefined;
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    functionsUrl: `${apiUrl.replace(/\/$/, "")}/functions/v1`,
    anonKey,
  };
}

function fromCli(): LocalStack {
  let status: Record<string, string>;
  try {
    status = JSON.parse(
      execFileSync("supabase", ["status", "-o", "json"], {
        encoding: "utf8",
        // Telemetry is what breaks this call; opting out is what makes it usable.
        env: { ...process.env, DO_NOT_TRACK: "1" },
      }),
    );
  } catch (err) {
    throw new Error(
      `could not read the local Supabase stack — neither .env.local nor \`supabase status\` provided its URL and anon key. Run \`task up\` (or \`task env\` if the stack is already running). ${
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

  return {
    apiUrl: required("API_URL", status.API_URL),
    functionsUrl: required("FUNCTIONS_URL", status.FUNCTIONS_URL),
    anonKey: required("ANON_KEY", process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY),
  };
}

export function localStack(): LocalStack {
  cached ??= fromEnvironment() ?? fromCli();
  return cached;
}

/** The shared secret the provider-webhook function checks on every call. */
export function webhookSecret(): string {
  const s = process.env.WEBHOOK_SHARED_SECRET;
  if (!s) throw new Error("WEBHOOK_SHARED_SECRET missing from .env.local");
  return s;
}
