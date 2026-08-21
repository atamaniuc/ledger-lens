// Command-wrapped tier (spec 0010, D-01): Supabase operations have no stable
// native Pulumi provider that earns its keep here (ADR 0001), so they run as
// @pulumi/command local.Command steps orchestrated by `pulumi up`.
//
// Honesty rules for command-wrapped steps:
//  - every step carries an explicit trigger derived from the files it depends
//    on, so a changed migration or function re-runs the step (a command that
//    never re-runs is a lie of a different kind);
//  - ordering is explicit via dependsOn: schema exists before the functions,
//    and the functions before the app's first request;
//  - the plan is DATA (SUPABASE_PLAN below); buildSupabase executes exactly
//    that data and the tests assert against the same data — code and claim
//    cannot drift.

import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { fileTrigger, REPO_ROOT, valueHash } from "./triggers.ts";
import type { InfraConfig } from "./config.ts";
import type { ResolvedEnvVar } from "./env.ts";

export interface SupabaseStepSpec {
  /** Resource name (also the plan key). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Repo-root-relative files/dirs whose content drives re-runs. */
  triggerFiles: string[];
  /** Names of earlier steps this step must run after. */
  dependsOn: string[];
}

/** The plan — pure data, no resources, no config. Tests assert against this. */
export const SUPABASE_PLAN: SupabaseStepSpec[] = [
  {
    name: "supabase-db-push",
    description: "Apply pending migrations to the hosted database.",
    // config.toml affects how migrations apply; migrations/ is the schema.
    triggerFiles: ["supabase/migrations", "supabase/config.toml"],
    dependsOn: [],
  },
  {
    name: "supabase-secrets-set",
    description:
      "Set the Edge Function shared secrets on the hosted project (both functions 401 every call without them).",
    // File-independent: re-runs when a secret VALUE changes (rotation). The
    // value hashes are injected as extraTriggers in buildSupabase.
    triggerFiles: [],
    dependsOn: ["supabase-db-push"],
  },
  {
    name: "supabase-deploy-provider-webhook",
    description: "Deploy the provider-webhook Edge Function.",
    // The function imports these shared files — a change to any of them must
    // re-deploy the function. `src/platform/hash.ts` is on the list because a
    // Deno function reaches it directly: it is the one place the digest lives,
    // and it may never import through a TypeScript path alias (D-49).
    triggerFiles: [
      "supabase/functions/provider-webhook",
      "src/features/ingestion/transform.ts",
      "src/platform/hash.ts",
      "src/features/ingestion/constants.ts",
    ],
    dependsOn: ["supabase-db-push", "supabase-secrets-set"],
  },
  {
    name: "supabase-deploy-embed",
    description: "Deploy the embed Edge Function.",
    triggerFiles: ["supabase/functions/embed"],
    dependsOn: ["supabase-db-push", "supabase-secrets-set"],
  },
];

export interface SupabaseCommands {
  dbPush: command.local.Command;
  secretsSet: command.local.Command;
  deployProviderWebhook: command.local.Command;
  deployEmbed: command.local.Command;
}

export function buildSupabase(cfg: InfraConfig, env: ResolvedEnvVar[]): SupabaseCommands {
  const webhook = env.find((e) => e.spec.key === "WEBHOOK_SHARED_SECRET")?.value;
  const embed = env.find((e) => e.spec.key === "EMBED_SHARED_SECRET")?.value;
  if (!webhook || !embed) {
    throw new Error("supabase build requires WEBHOOK_SHARED_SECRET and EMBED_SHARED_SECRET resolved env values");
  }

  const commandByStep: Record<string, string> = {
    "supabase-db-push": `supabase db push --project-ref ${cfg.supabaseProjectRef}`,
    "supabase-secrets-set":
      `supabase secrets set --project-ref ${cfg.supabaseProjectRef} ` +
      `WEBHOOK_SHARED_SECRET="\$WEBHOOK_SHARED_SECRET" EMBED_SHARED_SECRET="\$EMBED_SHARED_SECRET"`,
    "supabase-deploy-provider-webhook":
      `supabase functions deploy provider-webhook --project-ref ${cfg.supabaseProjectRef} --no-verify-jwt`,
    "supabase-deploy-embed":
      `supabase functions deploy embed --project-ref ${cfg.supabaseProjectRef} --no-verify-jwt`,
  };

  const environmentByStep: Record<string, Record<string, pulumi.Input<string>>> = {
    "supabase-db-push": {
      SUPABASE_ACCESS_TOKEN: cfg.supabaseAccessToken,
      SUPABASE_DB_PASSWORD: cfg.dbPassword,
      DO_NOT_TRACK: "1",
    },
    "supabase-secrets-set": {
      SUPABASE_ACCESS_TOKEN: cfg.supabaseAccessToken,
      WEBHOOK_SHARED_SECRET: webhook,
      EMBED_SHARED_SECRET: embed,
      DO_NOT_TRACK: "1",
    },
    "supabase-deploy-provider-webhook": {
      SUPABASE_ACCESS_TOKEN: cfg.supabaseAccessToken,
      DO_NOT_TRACK: "1",
    },
    "supabase-deploy-embed": {
      SUPABASE_ACCESS_TOKEN: cfg.supabaseAccessToken,
      DO_NOT_TRACK: "1",
    },
  };

  const created: Record<string, command.local.Command> = {};
  for (const step of SUPABASE_PLAN) {
    const triggers: pulumi.Input<any>[] = [];
    if (step.triggerFiles.length > 0) triggers.push(fileTrigger(step.triggerFiles));
    if (step.name === "supabase-secrets-set") {
      // sha256 of the secret value, not the value itself, as the trigger.
      triggers.push(webhook.apply((v) => valueHash(v)), embed.apply((v) => valueHash(v)));
    }
    created[step.name] = new command.local.Command(
      step.name,
      {
        dir: REPO_ROOT,
        create: commandByStep[step.name],
        environment: environmentByStep[step.name],
        triggers,
      },
      // Resource options carry the dependency edges: schema exists before the
      // secrets step, and both before the function deploys.
      { dependsOn: step.dependsOn.map((n) => created[n]) },
    );
  }

  return {
    dbPush: created["supabase-db-push"],
    secretsSet: created["supabase-secrets-set"],
    deployProviderWebhook: created["supabase-deploy-provider-webhook"],
    deployEmbed: created["supabase-deploy-embed"],
  };
}
