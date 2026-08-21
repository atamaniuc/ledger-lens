// Mock-based unit tests of the whole program (spec 0010 GATE): with
// pulumi.runtime.setMocks, no cloud credentials are needed — the point of
// the gate. Asserts: the Vercel project shape, env var coverage and secret
// marking, no secret in plaintext values/outputs, service-role key never in
// NEXT_PUBLIC_*, command ordering, and triggers derived from the files each
// command depends on.

import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { fileTrigger, REPO_ROOT, valueHash } from "../triggers.ts";
import { envCatalog } from "../env.ts";
import { SUPABASE_PLAN } from "../supabase.ts";

const PROJECT = "ledgerlens-infra";
const STACK = "prod";

interface CapturedResource {
  type: string;
  name: string;
  inputs: Record<string, any>;
}

const byType: Record<string, CapturedResource[]> = {};
const registrationOrder: string[] = [];

const TEST_CONFIG: Record<string, string> = {
  "ledgerlens-infra:supabaseProjectRef": "nhvtzdufsjtlwidnfkzo",
  "ledgerlens-infra:supabaseAnonKey": "anon-public-key-123",
  "ledgerlens-infra:mockProviderSeed": "42",
  "ledgerlens-infra:domain": "ledgerlens.test",
  "ledgerlens-infra:llmProvider": "groq",
  "ledgerlens-infra:groqApiKey": "groq-key-4",
  "ledgerlens-infra:groqModel": "openai/gpt-oss-20b",
  // secrets
  "ledgerlens-infra:vercelApiToken": "vercel-token-abc",
  "ledgerlens-infra:supabaseAccessToken": "sb-access-token-abc",
  "ledgerlens-infra:dbPassword": "db-password-abc",
  "ledgerlens-infra:supabaseServiceRoleKey": "service-role-key-SUPER-SECRET",
  "ledgerlens-infra:ingestionTriggerSecret": "ingestion-secret-1",
  "ledgerlens-infra:webhookSharedSecret": "webhook-secret-2",
  "ledgerlens-infra:embedSharedSecret": "embed-secret-3",
};

const PROJECT_TYPE = "vercel:index/project:Project";

/** Output exposes promise() at runtime but not in its public types. */
function resolveOutput<T>(o: pulumi.Output<T>): Promise<T> {
  return (o as unknown as { promise(withUnknowns?: boolean): Promise<T> }).promise();
}

// Pulumi serializes Input-typed arguments to the mock as a tagged wrapper
// { <sigil>: <sigil|secret-sigil>, value: <resolved> }; unwrap() extracts the
// resolved payload recursively.
function unwrap(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o && Object.keys(o).some((k) => k !== "value")) {
      return unwrap(o.value);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = unwrap(val);
    return out;
  }
  return v;
}
const ENV_VAR_TYPE = "vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable";
const DOMAIN_TYPE = "vercel:index/projectDomain:ProjectDomain";
const COMMAND_TYPE = "command:local:Command";

let built: any;

function captured(type: string): CapturedResource[] {
  return byType[type] ?? [];
}

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        registrationOrder.push(`${args.type}:${args.name}`);
        (byType[args.type] ??= []).push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: { ...args.inputs } };
      },
      call: (args) => args.inputs,
    },
    PROJECT,
    STACK,
    false,
  );

  for (const [k, v] of Object.entries(TEST_CONFIG)) {
    pulumi.runtime.setConfig(k, v);
  }

  const program = await import("../program.ts");
  built = program.buildInfra();

  // Flush pending registrations: awaiting the last resource's urn waits for
  // every earlier registration to complete through the mock monitor.
  await built.supabase.deployEmbed.urn;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("Vercel native tier", () => {
  it("creates the project with the expected name and framework", () => {
    const projects = captured(PROJECT_TYPE);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("ledgerlens");
    expect(projects[0].inputs.name).toBe("ledgerlens");
    expect(projects[0].inputs.framework).toBe("nextjs");
  });

  it("creates the custom domain when configured", () => {
    const domains = captured(DOMAIN_TYPE);
    expect(domains).toHaveLength(1);
    expect(domains[0].inputs.domain).toBe("ledgerlens.test");
    expect(domains[0].inputs.projectId).toBe("ledgerlens-id");
  });

  it("creates one env var per resolved catalog entry, targeting production", () => {
    const envVars = captured(ENV_VAR_TYPE);
    expect(envVars).toHaveLength(built.envVars.length);
    for (const ev of envVars) {
      expect(ev.inputs.targets).toEqual(["production"]);
    }
  });

  it("creates an env var for every REQUIRED catalog variable", () => {
    const keys = new Set(captured(ENV_VAR_TYPE).map((ev) => ev.inputs.key));
    for (const spec of envCatalog) {
      if (!spec.required) continue;
      expect(keys.has(spec.key), `required ${spec.key} has a Vercel env var`).toBe(true);
    }
  });
});

describe("secrets handling", () => {
  it("marks secret specs sensitive on Vercel and plaintext specs plain", () => {
    for (const ev of captured(ENV_VAR_TYPE)) {
      const spec = envCatalog.find((s) => s.key === ev.inputs.key);
      expect(spec, `catalog entry for ${ev.inputs.key}`).toBeDefined();
      expect(ev.inputs.sensitive, `${ev.inputs.key} sensitive matches catalog`).toBe(spec!.secret);
    }
  });

  it("never puts the service-role key (or any secret value) into a NEXT_PUBLIC_* variable", async () => {
    const values = new Map<string, string>();
    for (const ev of built.envVars as Array<{ spec: { key: string }; value: pulumi.Output<string> }>) {
      values.set(ev.spec.key, await resolveOutput(ev.value));
    }
    const secretValues = envCatalog
      .filter((s) => s.secret)
      .map((s) => values.get(s.key))
      .filter((v): v is string => v !== undefined);
    expect(secretValues.length).toBeGreaterThan(0);
    for (const spec of envCatalog) {
      if (!spec.key.startsWith("NEXT_PUBLIC_")) continue;
      const v = values.get(spec.key);
      expect(v).toBeDefined();
      for (const secret of secretValues) {
        expect(v, `${spec.key} never holds a secret value`).not.toBe(secret);
      }
    }
  });

  it("never leaks a secret value into a plaintext env var", async () => {
    const values = new Map<string, string>();
    for (const ev of built.envVars as Array<{ spec: { key: string }; value: pulumi.Output<string> }>) {
      values.set(ev.spec.key, await resolveOutput(ev.value));
    }
    const secretValues = new Set(
      envCatalog.filter((s) => s.secret).map((s) => values.get(s.key)).filter((v): v is string => v !== undefined),
    );
    for (const spec of envCatalog) {
      if (spec.secret) continue;
      const v = values.get(spec.key);
      if (v === undefined) continue;
      expect(secretValues.has(v), `plaintext ${spec.key} does not hold a secret value`).toBe(false);
    }
  });

  it("never puts a secret value into a stack export (plaintext output)", async () => {
    const values = new Map<string, string>();
    for (const ev of built.envVars as Array<{ spec: { key: string }; value: pulumi.Output<string> }>) {
      values.set(ev.spec.key, await resolveOutput(ev.value));
    }
    const secretValues = new Set(
      envCatalog.filter((s) => s.secret).map((s) => values.get(s.key)).filter((v): v is string => v !== undefined),
    );
    for (const [name, value] of Object.entries(built.exports as Record<string, string>)) {
      expect(secretValues.has(value), `export ${name} is not a secret value`).toBe(false);
    }
  });
});

describe("deploy-time app flags (D-16)", () => {
  it("sets APP_ENV=production and every CHAOS_* to false on Vercel", async () => {
    const keys = new Map<string, string>();
    for (const ev of built.envVars as Array<{ spec: { key: string }; value: pulumi.Output<string> }>) {
      keys.set(ev.spec.key, await resolveOutput(ev.value));
    }
    expect(keys.get("APP_ENV")).toBe("production");
    for (const flag of [
      "CHAOS_DUPLICATES",
      "CHAOS_SCHEMA_DRIFT",
      "CHAOS_NULL_FIELDS",
      "CHAOS_RATE_LIMIT",
      "CHAOS_SERVER_ERROR",
      "CHAOS_EXPIRED_TOKEN",
      "CHAOS_FUTURE_DATES",
    ]) {
      expect(keys.get(flag), `${flag} is "false"`).toBe("false");
    }
  });
});

describe("supabase command-wrapped tier", () => {
  it("registers db push, secrets set, then both function deploys, in plan order", () => {
    const commands = registrationOrder.filter((r) => r.startsWith(COMMAND_TYPE));
    expect(commands).toEqual([
      "command:local:Command:supabase-db-push",
      "command:local:Command:supabase-secrets-set",
      "command:local:Command:supabase-deploy-provider-webhook",
      "command:local:Command:supabase-deploy-embed",
    ]);
    // and the plan data agrees (code and claim cannot drift)
    expect(SUPABASE_PLAN.map((s) => s.name)).toEqual([
      "supabase-db-push",
      "supabase-secrets-set",
      "supabase-deploy-provider-webhook",
      "supabase-deploy-embed",
    ]);
  });

  it("runs commands from the repo root", () => {
    for (const step of SUPABASE_PLAN) {
      const cmd = captured(COMMAND_TYPE).find((c) => c.name === step.name);
      expect(cmd, step.name).toBeDefined();
      expect(cmd!.inputs.dir).toBe(REPO_ROOT);
    }
  });

  it("carries the trigger derived from the files each command depends on", () => {
    const webhookValue = "webhook-secret-2";
    const embedValue = "embed-secret-3";
    for (const step of SUPABASE_PLAN) {
      const cmd = captured(COMMAND_TYPE).find((c) => c.name === step.name);
      expect(cmd, step.name).toBeDefined();
      const triggers = (unwrap(cmd!.inputs.triggers) ?? []) as unknown[];
      if (step.triggerFiles.length > 0) {
        expect(triggers[0], `${step.name} file trigger matches recomputed digest`).toBe(
          fileTrigger(step.triggerFiles),
        );
      }
      if (step.name === "supabase-secrets-set") {
        // value-hash triggers re-run the step when a secret is rotated
        expect(triggers).toContain(valueHash(webhookValue));
        expect(triggers).toContain(valueHash(embedValue));
      } else {
        expect(triggers.length).toBeGreaterThan(0);
      }
    }
  });

  it("passes the supabase access token to every command", () => {
    for (const step of SUPABASE_PLAN) {
      const cmd = captured(COMMAND_TYPE).find((c) => c.name === step.name);
      const environment = (unwrap(cmd!.inputs.environment) ?? {}) as Record<string, string>;
      expect(environment.SUPABASE_ACCESS_TOKEN).toBe("sb-access-token-abc");
    }
  });
});

describe("Modal (spec 0009)", () => {
  it("registers nothing — the stub is disabled", () => {
    const modalLike = registrationOrder.filter((r) => /modal/i.test(r));
    expect(modalLike).toEqual([]);
  });
});
