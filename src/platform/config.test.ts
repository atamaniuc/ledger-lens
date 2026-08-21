import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  envSchema,
  getChaosFlags,
  getLlmProvider,
  getServiceRoleKey,
  getSupabaseUrl,
  loadEnv,
} from "./config";

// Every required variable, with values that match the schema's shapes.
const fullEnv: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  INGESTION_TRIGGER_SECRET: "ingestion-secret",
  WEBHOOK_SHARED_SECRET: "webhook-secret",
  EMBED_SHARED_SECRET: "embed-secret",
  MOCK_PROVIDER_SEED: "42",
  LLM_PROVIDER: "groq",
  GROQ_API_KEY: "gsk-...",
  GROQ_MODEL: "openai/gpt-oss-20b",
};

describe("envSchema", () => {
  test("parses a complete environment into typed values", () => {
    const parsed = envSchema.parse(fullEnv);
    expect(parsed.SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(parsed.MOCK_PROVIDER_SEED).toBe(42); // coerced string → number
    expect(parsed.LLM_PROVIDER).toBe("groq");
  });

  test("chaos flags carry no default here, and accept string booleans", () => {
    // Deliberately undefined when unset: since D-16 an unset flag means
    // whatever APP_ENV implies, and src/features/provider/chaos.ts is the one
    // place that decides. A default in this schema would be a second answer
    // that disagreed silently in production.
    const parsed = envSchema.parse(fullEnv);
    expect(parsed.CHAOS_DUPLICATES).toBeUndefined();
    expect(parsed.CHAOS_FUTURE_DATES).toBeUndefined();

    const set = envSchema.parse({
      ...fullEnv,
      CHAOS_DUPLICATES: "false",
      CHAOS_RATE_LIMIT: "0",
      CHAOS_SCHEMA_DRIFT: "true",
      CHAOS_NULL_FIELDS: "1",
    });
    expect(set.CHAOS_DUPLICATES).toBe(false);
    expect(set.CHAOS_RATE_LIMIT).toBe(false);
    expect(set.CHAOS_SCHEMA_DRIFT).toBe(true);
    expect(set.CHAOS_NULL_FIELDS).toBe(true);
    expect(set.CHAOS_SERVER_ERROR).toBeUndefined();
  });

  test("the new guardrail and budget keys carry usable defaults", () => {
    const parsed = envSchema.parse(fullEnv);
    expect(parsed.INGEST_BUDGET_MS).toBe(25_000); // under a serverless request limit (D-17)
    expect(parsed.AGENT_USER_RATE_LIMIT).toBe(60);
    expect(parsed.AGENT_ORG_RATE_LIMIT).toBe(300);
    expect(parsed.AGENT_DAILY_COST_CAP_CENTS).toBe(1000);
    expect(envSchema.parse({ ...fullEnv, INGEST_BUDGET_MS: "9000" }).INGEST_BUDGET_MS).toBe(9000);
    expect(() => envSchema.parse({ ...fullEnv, INGEST_BUDGET_MS: "600000" })).toThrow();
  });

  test("rejects an unknown LLM_PROVIDER value", () => {
    expect(() => envSchema.parse({ ...fullEnv, LLM_PROVIDER: "not-a-provider" })).toThrow();
  });
});

describe("loadEnv", () => {
  test("returns the parsed environment", () => {
    const env = loadEnv(fullEnv);
    expect(env.SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(env.CHAOS_DUPLICATES).toBeUndefined();
  });

  test("throws a ConfigError naming every missing required variable", () => {
    try {
      loadEnv({});
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("SUPABASE_URL");
      expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
      expect(message).toContain("INGESTION_TRIGGER_SECRET");
      expect(message).toContain("WEBHOOK_SHARED_SECRET");
      expect(message).toContain("EMBED_SHARED_SECRET");
    }
  });

  test("throws naming the invalid variable when a value is malformed", () => {
    try {
      loadEnv({ ...fullEnv, MOCK_PROVIDER_SEED: "not-a-number" });
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("MOCK_PROVIDER_SEED");
    }
  });

  test("parses once and serves cached values through the typed getters", () => {
    loadEnv(fullEnv); // populates the cache
    expect(getSupabaseUrl()).toBe("http://127.0.0.1:54321");
    expect(getServiceRoleKey()).toBe("service-role-key");
    expect(getLlmProvider()).toBe("groq");
    // Explicitly configured flags come back as configured; an unset flag comes
    // back undefined, because since D-16 what "unset" means is APP_ENV's
    // answer, given by src/features/provider/chaos.ts — not this schema's.
    loadEnv({ ...fullEnv, CHAOS_DUPLICATES: "true" });
    expect(getChaosFlags().duplicates).toBe(true);
    loadEnv(fullEnv);
    expect(getChaosFlags().duplicates).toBeUndefined();
  });
});

describe("the .env.example template", () => {
  // The template is documentation, so it drifts unless something checks it.
  // This is the check: every variable the schema knows about is mentioned in
  // .env.example, commented or not. A key added to the schema and not
  // documented fails here rather than in someone's first hour on the project.
  const template = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const documented = new Set(
    [...template.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]),
  );

  test("documents every variable in the schema", () => {
    const missing = Object.keys(envSchema.shape).filter((key) => !documented.has(key));
    expect(missing, `not in .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  test("documents nothing the schema does not read", () => {
    const known = new Set(Object.keys(envSchema.shape));
    const extra = [...documented].filter((key) => !known.has(key));
    expect(extra, `in .env.example but unread: ${extra.join(", ")}`).toEqual([]);
  });

  test("contains no value that looks like a real secret", () => {
    // Placeholders and public defaults only: a value carrying a provider's key
    // prefix is a leak, not an example.
    expect(template).not.toMatch(/\b(sk-|gsk_|nvapi-|eyJhbGciOi)/);
  });
});
