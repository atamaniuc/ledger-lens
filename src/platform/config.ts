import { z } from "zod";

// One schema for every environment variable the app reads (D-21). Nothing
// here throws at import time: call loadEnv() once at the process boundary,
// or use the typed getters below, which parse lazily and cache. A missing or
// invalid variable fails with a message that names it.
//
// SERVER-ONLY: this module holds the service-role key and the ingestion
// secrets. Never import it into a client component or anything that reaches
// the browser bundle (same rule as src/platform/supabase/service-client.ts, ADR 0007).

// Chaos flags are strings in the environment ("true"/"false"/"0"/"1"). No
// default here on purpose: src/features/provider/chaos.ts decides what an
// unset flag means, and since D-16 that answer depends on APP_ENV — on in
// dev and test, off everywhere else. A default in this schema would be a
// second, silently disagreeing answer.
const booleanish = z
  .enum(["true", "false", "0", "1"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true" || value === "1"));

export const envSchema = z.object({
  // Supabase — server (service-role client, ingestion routes).
  SUPABASE_URL: z.string().min(1, "is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "is required"),
  // Supabase — browser (public anon key, RLS does the protecting).
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1, "is required"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "is required"),
  // Entry-point secrets: every one of these routes rejects requests when its
  // secret is unset, so they are required, not optional.
  INGESTION_TRIGGER_SECRET: z.string().min(1, "is required"),
  WEBHOOK_SHARED_SECRET: z.string().min(1, "is required"),
  EMBED_SHARED_SECRET: z.string().min(1, "is required"),
  // Mock provider (optional knobs, defaults live in src/features/provider/).
  MOCK_PROVIDER_BASE_URL: z.string().url().optional(),
  MOCK_PROVIDER_SEED: z.coerce.number().int().optional(),
  // LLM provider — see src/features/agent/providers/index.ts for the resolution rule
  // (LLM_PROVIDER names one explicitly; otherwise the first configured key
  // wins). None are required: a deployment without any key simply has no
  // model, which the agent route reports as a 503.
  LLM_PROVIDER: z.enum(["anthropic", "groq", "nvidia", "openai-compatible"]).optional(),
  // The failover chain (decision 0010): an ordered preference list, tried in
  // order on 429/5xx/timeout. Not a load balancer — free models differ in
  // quality, so the order is deterministic and the fallback is recorded.
  LLM_CHAIN: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).optional(),
  NVIDIA_API_KEY: z.string().min(1).optional(),
  NVIDIA_MODEL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  // Mock-provider chaos flags — on by default (the failure modes are the
  // regression tests), toggleable deploy-wide per flag.
  CHAOS_DUPLICATES: booleanish,
  CHAOS_SCHEMA_DRIFT: booleanish,
  CHAOS_NULL_FIELDS: booleanish,
  CHAOS_RATE_LIMIT: booleanish,
  CHAOS_SERVER_ERROR: booleanish,
  CHAOS_EXPIRED_TOKEN: booleanish,
  CHAOS_FUTURE_DATES: booleanish,
  // Which environment this is. Chaos flags and any other "development only"
  // behaviour read this rather than guessing from NODE_ENV (D-16).
  APP_ENV: z.enum(["dev", "test", "production"]).optional(),
  // The groundedness judge (spec 0008). A separate provider on purpose: a model
  // that grades its own answer is not a second signal, and decision 0010 keeps
  // every provider on a free tier. `py/ledgerlens_judge` refuses to run when
  // JUDGE_MODEL equals the answering model.
  JUDGE_PROVIDER: z.enum(["groq", "nvidia", "openai-compatible"]).optional(),
  JUDGE_MODEL: z.string().min(1).optional(),
  JUDGE_API_KEY: z.string().min(1).optional(),
  JUDGE_BASE_URL: z.string().url().optional(),
  // Ingestion run budget (D-17). The old 45s constant outlived the serverless
  // request limit it had to fit inside; 25s does, and the platform's own limit
  // is documented in the runbook.
  INGEST_BUDGET_MS: z.coerce.number().int().positive().max(300_000).default(25_000),
  // Agent guardrails (D-18). Requests per window per user and per org, and a
  // daily spend ceiling in cents computed from llm_calls; 0 disables the cap.
  AGENT_USER_RATE_LIMIT: z.coerce.number().int().nonnegative().default(60),
  AGENT_ORG_RATE_LIMIT: z.coerce.number().int().nonnegative().default(300),
  AGENT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  AGENT_DAILY_COST_CAP_CENTS: z.coerce.number().int().nonnegative().default(1000),
  // Daily token budget per org, summed from llm_calls. Counts tokens, not
  // cents, because a free tier records cost 0 while still burning the
  // provider's quota — this is the guard that cannot be walked around by a
  // zero-cost model (D-52). 0 disables it.
  AGENT_DAILY_TOKEN_CAP: z.coerce.number().int().nonnegative().default(200_000),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Environment configuration is incomplete — fix these and restart:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

let cached: Env | null = null;

/** Parse the environment once. Throws ConfigError naming every bad variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join(".");
      const detail = issue.message === "Required" ? "is required" : issue.message;
      return `${name} ${detail}`;
    });
    throw new ConfigError(problems);
  }
  cached = parsed.data;
  return cached;
}

/** The parsed, cached environment; parses on first use. */
function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

// Typed getters — one place for a caller to reach a value without knowing
// the schema. Each returns the validated type.
export const getSupabaseUrl = (): string => env().SUPABASE_URL;
export const getServiceRoleKey = (): string => env().SUPABASE_SERVICE_ROLE_KEY;
export const getLlmProvider = (): Env["LLM_PROVIDER"] => env().LLM_PROVIDER;

/**
 * The seven chaos flags as explicitly configured. `undefined` means "not
 * configured" — src/features/provider/chaos.ts resolves that against APP_ENV
 * (D-16), and this getter deliberately does not guess on its behalf.
 */
export function getChaosFlags(): {
  duplicates: boolean | undefined;
  schemaDrift: boolean | undefined;
  nullFields: boolean | undefined;
  rateLimit: boolean | undefined;
  serverError: boolean | undefined;
  expiredToken: boolean | undefined;
  futureDates: boolean | undefined;
} {
  const e = env();
  return {
    duplicates: e.CHAOS_DUPLICATES,
    schemaDrift: e.CHAOS_SCHEMA_DRIFT,
    nullFields: e.CHAOS_NULL_FIELDS,
    rateLimit: e.CHAOS_RATE_LIMIT,
    serverError: e.CHAOS_SERVER_ERROR,
    expiredToken: e.CHAOS_EXPIRED_TOKEN,
    futureDates: e.CHAOS_FUTURE_DATES,
  };
}
