// THE single typed place every environment variable the app needs on Vercel
// comes from (spec 0010, D-01). The catalog below is cross-checked against
// the repo's .env.example (validateCatalog, called at program load) and the
// unit tests. A required variable that cannot be resolved fails `pulumi up`
// with the exact command to fix it — a broken deployment is never produced.

import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./triggers.ts";
import type { InfraConfig } from "./config.ts";

export type EnvSource = "config" | "derived" | "fixed";

export interface EnvVarSpec {
  /** Vercel environment variable name. */
  key: string;
  /** Why the app needs it. */
  description: string;
  /** Required = a missing value fails `pulumi up` instead of shipping broken. */
  required: boolean;
  /** Secret = encrypted in Pulumi state and "sensitive" on Vercel. */
  secret: boolean;
  /** Public = safe in the browser bundle; a secret must never be public. */
  public: boolean;
  source: EnvSource;
  /** Pulumi config key when source === "config" (secret keys are set --secret). */
  configKey?: string;
  /** Literal value when source === "fixed". */
  fixedValue?: string;
  /** Default when an optional config key is unset. */
  optionalDefault?: string;
}

// Chaos flags (D-16): off in production, enforced here at deploy time. The
// app's mock provider defaults them ON; the deployed app must never see an ON
// flag, so they are fixed literals, not configurable knobs.
export const CHAOS_FLAG_KEYS = [
  "CHAOS_DUPLICATES",
  "CHAOS_SCHEMA_DRIFT",
  "CHAOS_NULL_FIELDS",
  "CHAOS_RATE_LIMIT",
  "CHAOS_SERVER_ERROR",
  "CHAOS_EXPIRED_TOKEN",
  "CHAOS_FUTURE_DATES",
] as const;

// APP_ENV is an infra-owned flag (D-16 consumes it) that .env.example does
// not document yet — the only catalog keys exempt from the .env.example
// cross-check, asserted explicitly in tests.
export const INFRA_OWNED_KEYS = ["APP_ENV", ...CHAOS_FLAG_KEYS] as const;

export const envCatalog: EnvVarSpec[] = [
  // Supabase — browser. Public by design: they only ever reach Postgres,
  // where RLS decides what comes back (ADR 0007).
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    description: "Browser-facing Supabase URL (public; RLS is the boundary).",
    required: true,
    secret: false,
    public: true,
    source: "derived",
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    description: "Public anon key served to the browser bundle.",
    required: true,
    secret: false,
    public: true,
    source: "config",
    configKey: "supabaseAnonKey",
  },
  // Supabase — server only.
  {
    key: "SUPABASE_URL",
    description: "Server-side Supabase URL (service client, ingestion routes).",
    required: true,
    secret: false,
    public: false,
    source: "derived",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    description: "Service-role key — bypasses RLS. Server-only; never NEXT_PUBLIC_*.",
    required: true,
    secret: true,
    public: false,
    source: "config",
    configKey: "supabaseServiceRoleKey",
  },
  // Entry-point secrets: each of these routes rejects requests when its
  // secret is unset, so they are required, not optional.
  {
    key: "INGESTION_TRIGGER_SECRET",
    description: "x-ingestion-secret checked by POST /api/ingestion/run and /api/data-quality/run.",
    required: true,
    secret: true,
    public: false,
    source: "config",
    configKey: "ingestionTriggerSecret",
  },
  {
    key: "WEBHOOK_SHARED_SECRET",
    description: "x-webhook-secret checked by the provider-webhook Edge Function (caller's copy).",
    required: true,
    secret: true,
    public: false,
    source: "config",
    configKey: "webhookSharedSecret",
  },
  {
    key: "EMBED_SHARED_SECRET",
    description: "x-embed-secret checked by the embed Edge Function (caller's copy).",
    required: true,
    secret: true,
    public: false,
    source: "config",
    configKey: "embedSharedSecret",
  },
  // Mock provider knobs.
  {
    key: "MOCK_PROVIDER_BASE_URL",
    description: "Base URL the ingestion route uses to reach the mock provider (defaults to self-origin).",
    required: false,
    secret: false,
    public: false,
    source: "config",
    configKey: "mockProviderBaseUrl",
  },
  {
    key: "MOCK_PROVIDER_SEED",
    description: "Deterministic seed for the mock provider dataset.",
    required: false,
    secret: false,
    public: false,
    source: "config",
    configKey: "mockProviderSeed",
    optionalDefault: "42",
  },
  // LLM provider (Stage 5): none are required — a deployment without a key
  // has no model, which the agent route reports as a 503. Keys are secrets.
  {
    key: "LLM_PROVIDER",
    description: "Pin exactly one provider: anthropic | groq | nvidia | openai-compatible.",
    required: false,
    secret: false,
    public: false,
    source: "config",
    configKey: "llmProvider",
  },
  { key: "ANTHROPIC_API_KEY", description: "Anthropic key (server-only).", required: false, secret: true, public: false, source: "config", configKey: "anthropicApiKey" },
  { key: "ANTHROPIC_MODEL", description: "Anthropic model id.", required: false, secret: false, public: false, source: "config", configKey: "anthropicModel" },
  { key: "GROQ_API_KEY", description: "Groq key (server-only, free tier).", required: false, secret: true, public: false, source: "config", configKey: "groqApiKey" },
  { key: "GROQ_MODEL", description: "Groq model id.", required: false, secret: false, public: false, source: "config", configKey: "groqModel" },
  { key: "NVIDIA_API_KEY", description: "NVIDIA NIM key (server-only, free tier).", required: false, secret: true, public: false, source: "config", configKey: "nvidiaApiKey" },
  { key: "NVIDIA_MODEL", description: "NVIDIA NIM model id.", required: false, secret: false, public: false, source: "config", configKey: "nvidiaModel" },
  { key: "LLM_API_KEY", description: "Generic OpenAI-compatible key (server-only).", required: false, secret: true, public: false, source: "config", configKey: "llmApiKey" },
  { key: "LLM_BASE_URL", description: "Generic OpenAI-compatible base URL.", required: false, secret: false, public: false, source: "config", configKey: "llmBaseUrl" },
  { key: "LLM_MODEL", description: "Generic OpenAI-compatible model id.", required: false, secret: false, public: false, source: "config", configKey: "llmModel" },
  // Deploy-time flags (D-16): the deployed app must have chaos OFF.
  {
    key: "APP_ENV",
    description: "App environment. production here — D-16 turns chaos OFF outside dev/test.",
    required: true,
    secret: false,
    public: false,
    source: "fixed",
    fixedValue: "production",
  },
  ...CHAOS_FLAG_KEYS.map(
    (key): EnvVarSpec => ({
      key,
      description: "Chaos flag, explicitly OFF in production (D-16).",
      required: true,
      secret: false,
      public: false,
      source: "fixed",
      fixedValue: "false",
    }),
  ),
];

/** The keys .env.example documents, parsed from the file itself. */
export function documentedEnvKeys(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Cross-checked at program load (and by catalog.test.ts): every catalog key
// must be documented in .env.example unless it is infra-owned (APP_ENV,
// CHAOS_* — .env.example predates D-16). No invented variables.
export function validateCatalog(): void {
  const documented = documentedEnvKeys();
  const undocumented = envCatalog
    .map((s) => s.key)
    .filter((k) => !documented.has(k) && !(INFRA_OWNED_KEYS as readonly string[]).includes(k));
  if (undocumented.length > 0) {
    throw new Error(
      `infra env catalog names variables .env.example does not document: ${undocumented.join(", ")}. Add them to .env.example or drop them from env.ts.`,
    );
  }
  const problems: string[] = [];
  for (const spec of envCatalog) {
    if (spec.public && spec.secret) {
      problems.push(`${spec.key}: marked both public and secret — a secret must never be public`);
    }
    if (spec.secret && spec.source !== "config") {
      problems.push(`${spec.key}: secret vars must come from secret Pulumi config`);
    }
    if (spec.source === "fixed" && spec.fixedValue === undefined) {
      problems.push(`${spec.key}: fixed source without fixedValue`);
    }
    if (spec.source === "config" && spec.configKey === undefined) {
      problems.push(`${spec.key}: config source without configKey`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`env catalog invariant violation:\n  - ${problems.join("\n  - ")}`);
  }
}

/** The service-role key must never be bound to a NEXT_PUBLIC_* variable. */
export function assertServiceRoleKeyIsNotPublic(): void {
  for (const spec of envCatalog) {
    if (spec.key.startsWith("NEXT_PUBLIC_") && spec.configKey === "supabaseServiceRoleKey") {
      throw new Error(`${spec.key} is bound to the service-role key — that key is server-only.`);
    }
  }
}

export interface ResolvedEnvVar {
  spec: EnvVarSpec;
  value: pulumi.Output<string>;
}

const SECRET_BY_CONFIG_KEY: Record<string, (c: InfraConfig) => pulumi.Output<string> | undefined> = {
  supabaseServiceRoleKey: (c) => c.serviceRoleKey,
  ingestionTriggerSecret: (c) => c.ingestionTriggerSecret,
  webhookSharedSecret: (c) => c.webhookSharedSecret,
  embedSharedSecret: (c) => c.embedSharedSecret,
  anthropicApiKey: (c) => c.anthropicApiKey,
  groqApiKey: (c) => c.groqApiKey,
  nvidiaApiKey: (c) => c.nvidiaApiKey,
  llmApiKey: (c) => c.llmApiKey,
};

const PLAIN_BY_CONFIG_KEY: Record<string, (c: InfraConfig) => string | undefined> = {
  supabaseAnonKey: (c) => c.supabaseAnonKey,
  mockProviderBaseUrl: (c) => c.mockProviderBaseUrl,
  mockProviderSeed: (c) => c.mockProviderSeed,
  llmProvider: (c) => c.llmProvider,
  anthropicModel: (c) => c.anthropicModel,
  groqModel: (c) => c.groqModel,
  nvidiaModel: (c) => c.nvidiaModel,
  llmBaseUrl: (c) => c.llmBaseUrl,
  llmModel: (c) => c.llmModel,
};

function deriveValue(key: string, cfg: InfraConfig): string {
  switch (key) {
    case "NEXT_PUBLIC_SUPABASE_URL":
    case "SUPABASE_URL":
      return cfg.supabaseProjectUrl;
    default:
      throw new Error(`env catalog: no derivation for derived key ${key}`);
  }
}

/**
 * Resolve every catalog variable against the loaded config. Any *required*
 * variable that cannot be resolved throws here, listing every missing key at
 * once — this is what makes a missing variable fail `pulumi up` instead of
 * producing a broken deployment.
 */
export function resolveEnv(cfg: InfraConfig): ResolvedEnvVar[] {
  const missing: string[] = [];
  const out: ResolvedEnvVar[] = [];
  for (const spec of envCatalog) {
    let value: pulumi.Output<string> | string | undefined;
    if (spec.source === "fixed") {
      value = spec.fixedValue;
    } else if (spec.source === "derived") {
      value = deriveValue(spec.key, cfg);
    } else if (spec.secret) {
      value = spec.configKey ? SECRET_BY_CONFIG_KEY[spec.configKey]?.(cfg) : undefined;
    } else {
      const v = spec.configKey ? PLAIN_BY_CONFIG_KEY[spec.configKey]?.(cfg) : undefined;
      value = v ?? spec.optionalDefault;
    }
    if (value === undefined || value === "") {
      if (spec.required) {
        missing.push(spec.configKey ? `${spec.key} (config key: ${spec.configKey})` : spec.key);
      }
      continue;
    }
    out.push({ spec, value: pulumi.output(value) });
  }
  if (missing.length > 0) {
    throw new Error(
      "Required environment variables for Vercel are not configured — refusing to ship a broken deployment:\n  - " +
        missing.join("\n  - ") +
        "\nFix: pulumi config set <configKey> <value>  (secrets: pulumi config set --secret <configKey> <value>)",
    );
  }
  return out;
}
