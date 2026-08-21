// Pure-data tests: the env catalog, its .env.example cross-check, the chaos
// flags, the supabase plan, and trigger derivation. No Pulumi runtime, no
// mocks, no resources — this file runs in its own vitest worker.

import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAOS_FLAG_KEYS,
  assertServiceRoleKeyIsNotPublic,
  documentedEnvKeys,
  envCatalog,
  validateCatalog,
} from "../env.ts";
import { SUPABASE_PLAN } from "../supabase.ts";
import { fileTrigger } from "../triggers.ts";

describe("env catalog vs .env.example", () => {
  it("documents every catalog key in .env.example (infra-owned keys exempt)", () => {
    expect(() => validateCatalog()).not.toThrow();
  });

  it("covers every variable the app's zod schema hard-requires", () => {
    const documented = documentedEnvKeys();
    const required = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "INGESTION_TRIGGER_SECRET",
      "WEBHOOK_SHARED_SECRET",
      "EMBED_SHARED_SECRET",
    ];
    for (const key of required) {
      expect(documented.has(key), `${key} is documented in .env.example`).toBe(true);
      expect(envCatalog.some((s) => s.key === key), `${key} is in the infra catalog`).toBe(true);
    }
  });
});

describe("env catalog invariants", () => {
  it("never marks a variable both public and secret", () => {
    for (const spec of envCatalog) {
      expect(spec.public && spec.secret, `${spec.key} is public AND secret`).toBe(false);
    }
  });

  it("never binds the service-role key to a NEXT_PUBLIC_* variable", () => {
    expect(() => assertServiceRoleKeyIsNotPublic()).not.toThrow();
    for (const spec of envCatalog) {
      if (spec.key.startsWith("NEXT_PUBLIC_")) {
        expect(spec.configKey).not.toBe("supabaseServiceRoleKey");
      }
    }
  });

  it("marks the service-role key and the shared secrets as secrets", () => {
    for (const key of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "INGESTION_TRIGGER_SECRET",
      "WEBHOOK_SHARED_SECRET",
      "EMBED_SHARED_SECRET",
      "GROQ_API_KEY",
    ]) {
      const spec = envCatalog.find((s) => s.key === key);
      expect(spec, key).toBeDefined();
      expect(spec!.secret, `${key} is secret`).toBe(true);
      expect(spec!.public, `${key} is not public`).toBe(false);
    }
  });

  it("marks the anon key and Supabase URLs as public, not secret", () => {
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
      const spec = envCatalog.find((s) => s.key === key);
      expect(spec!.secret, `${key} is not secret`).toBe(false);
      expect(spec!.public, `${key} is public`).toBe(true);
    }
  });

  it("gives every required variable a resolvable source", () => {
    for (const spec of envCatalog) {
      if (!spec.required) continue;
      expect(
        ["fixed", "derived", "config"].includes(spec.source),
        `${spec.key} required with source ${spec.source}`,
      ).toBe(true);
      if (spec.source === "fixed") expect(spec.fixedValue, `${spec.key} fixedValue`).toBeDefined();
      if (spec.source === "config") expect(spec.configKey, `${spec.key} configKey`).toBeDefined();
    }
  });
});

describe("chaos flags are OFF in production (D-16)", () => {
  it("sets APP_ENV=production explicitly", () => {
    const spec = envCatalog.find((s) => s.key === "APP_ENV");
    expect(spec?.fixedValue).toBe("production");
  });

  it("sets every CHAOS_* flag to false explicitly", () => {
    for (const key of CHAOS_FLAG_KEYS) {
      const spec = envCatalog.find((s) => s.key === key);
      expect(spec?.fixedValue, `${key} is "false"`).toBe("false");
    }
  });
});

describe("supabase plan (spec 0010)", () => {
  const names = SUPABASE_PLAN.map((s) => s.name);

  it("runs db push before both functions deploy, and secrets-set between", () => {
    expect(names[0]).toBe("supabase-db-push");
    const dbIdx = names.indexOf("supabase-db-push");
    const secretsIdx = names.indexOf("supabase-secrets-set");
    expect(secretsIdx).toBeGreaterThan(dbIdx);
    for (const deploy of ["supabase-deploy-provider-webhook", "supabase-deploy-embed"]) {
      const idx = names.indexOf(deploy);
      expect(idx).toBeGreaterThan(dbIdx);
      expect(idx).toBeGreaterThan(secretsIdx);
      const step = SUPABASE_PLAN.find((s) => s.name === deploy)!;
      expect(step.dependsOn).toContain("supabase-db-push");
      expect(step.dependsOn).toContain("supabase-secrets-set");
    }
  });

  it("gives every deploy step a trigger derived from the files it depends on", () => {
    for (const step of SUPABASE_PLAN) {
      if (step.triggerFiles.length === 0) continue;
      expect(() => fileTrigger(step.triggerFiles), `${step.name} trigger computes`).not.toThrow();
    }
  });
});

describe("file triggers are deterministic and content-derived", () => {
  it("is independent of argument order", () => {
    expect(fileTrigger(["supabase/config.toml", "supabase/migrations"])).toBe(
      fileTrigger(["supabase/migrations", "supabase/config.toml"]),
    );
  });

  it("changes when a file's content changes", () => {
    const tmpRel = "infra/__tests__/.tmp-trigger";
    const absDir = join(process.cwd(), "__tests__", ".tmp-trigger");
    mkdirSync(absDir, { recursive: true });
    try {
      const rel = join(tmpRel, "x.ts");
      writeFileSync(join(absDir, "x.ts"), "v1");
      const a = fileTrigger([rel]);
      writeFileSync(join(absDir, "x.ts"), "v2");
      const b = fileTrigger([rel]);
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(absDir, { recursive: true, force: true });
    }
  });
});
