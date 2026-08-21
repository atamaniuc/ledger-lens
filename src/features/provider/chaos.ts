// Chaos flags — the seven failure modes the mock provider deliberately
// injects, per .claude/PRD.md "Mock Provider" US-02. Independently
// toggleable via env var (deploy-wide default) or query param
// (per-request override, for tests that want one flag isolated).

export interface ChaosFlags {
  duplicates: boolean;
  schemaDrift: boolean;
  nullFields: boolean;
  rateLimit: boolean;
  serverError: boolean;
  expiredToken: boolean;
  futureDates: boolean;
}

const FLAG_NAMES = [
  "duplicates",
  "schemaDrift",
  "nullFields",
  "rateLimit",
  "serverError",
  "expiredToken",
  "futureDates",
] as const;

const ENV_VAR_NAMES: Record<(typeof FLAG_NAMES)[number], string> = {
  duplicates: "CHAOS_DUPLICATES",
  schemaDrift: "CHAOS_SCHEMA_DRIFT",
  nullFields: "CHAOS_NULL_FIELDS",
  rateLimit: "CHAOS_RATE_LIMIT",
  serverError: "CHAOS_SERVER_ERROR",
  expiredToken: "CHAOS_EXPIRED_TOKEN",
  futureDates: "CHAOS_FUTURE_DATES",
};

const ALL_ON: ChaosFlags = {
  duplicates: true,
  schemaDrift: true,
  nullFields: true,
  rateLimit: true,
  serverError: true,
  expiredToken: true,
  futureDates: true,
};

const ALL_OFF: ChaosFlags = {
  duplicates: false,
  schemaDrift: false,
  nullFields: false,
  rateLimit: false,
  serverError: false,
  expiredToken: false,
  futureDates: false,
};

// D-16: chaos is a development/test feature — a deployed instance that
// rate-limits and 500s itself is not a mock provider, it is a production
// incident. The *default* for every flag is therefore OFF unless the
// environment is explicitly dev/test: APP_ENV=dev|test, or (when APP_ENV
// is unset, as it is under next dev and Vitest) NODE_ENV=development|test.
// The flags themselves are not softened — when they are on they fire, and
// the regression suite is what proves it (CLAUDE.md forbids weakening
// them). Per-flag env overrides (CHAOS_*) and per-request query params
// still work everywhere, so tests can isolate one failure mode at a time.
export function chaosEnabledByDefault(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const appEnv = env.APP_ENV;
  if (appEnv) return appEnv === "dev" || appEnv === "test";
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return value !== "false" && value !== "0";
}

export function resolveFlags(
  searchParams: URLSearchParams,
  env: Record<string, string | undefined> = process.env,
): ChaosFlags {
  const base = chaosEnabledByDefault(env) ? ALL_ON : ALL_OFF;
  const result = {} as ChaosFlags;
  for (const name of FLAG_NAMES) {
    const envDefault = parseBool(env[ENV_VAR_NAMES[name]], base[name]);
    result[name] = parseBool(searchParams.get(name), envDefault);
  }
  return result;
}
