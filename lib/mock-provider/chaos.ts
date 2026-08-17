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

// On by default — an off-by-default mock provider is just a fixture,
// not an adversary. Flip individual flags off via env or query param
// for tests that need to isolate one failure mode at a time.
const DEFAULTS: ChaosFlags = {
  duplicates: true,
  schemaDrift: true,
  nullFields: true,
  rateLimit: true,
  serverError: true,
  expiredToken: true,
  futureDates: true,
};

function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return value !== "false" && value !== "0";
}

export function resolveFlags(searchParams: URLSearchParams): ChaosFlags {
  const result = {} as ChaosFlags;
  for (const name of FLAG_NAMES) {
    const envDefault = parseBool(process.env[ENV_VAR_NAMES[name]], DEFAULTS[name]);
    result[name] = parseBool(searchParams.get(name), envDefault);
  }
  return result;
}
