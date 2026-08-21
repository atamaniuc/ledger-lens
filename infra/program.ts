// Program wiring (spec 0010, D-01). buildInfra() is the single entry point
// for the whole deployable surface: tests call it under pulumi.runtime mocks,
// and index.ts calls it under the real engine. Every validation here runs
// BEFORE any resource is registered, so `pulumi up` fails fast and names the
// fix instead of shipping a broken deployment.

import { loadConfig, type InfraConfig } from "./config.ts";
import {
  assertServiceRoleKeyIsNotPublic,
  resolveEnv,
  validateCatalog,
  type ResolvedEnvVar,
} from "./env.ts";
import { buildVercel, type VercelResources } from "./vercel.ts";
import { buildSupabase, type SupabaseCommands } from "./supabase.ts";
import { buildModal } from "./modal.ts";
import { assertRepoLayout } from "./triggers.ts";

export interface BuiltInfra {
  cfg: InfraConfig;
  envVars: ResolvedEnvVar[];
  vercel: VercelResources;
  supabase: SupabaseCommands;
  /** Stack outputs — PUBLIC VALUES ONLY. A secret here would be plaintext in
   *  `pulumi stack output` and in Pulumi Cloud. Asserted by test. */
  exports: Record<string, string>;
}

export function buildInfra(): BuiltInfra {
  assertRepoLayout(); // must run with infra/ as the working directory
  validateCatalog(); // catalog vs .env.example cross-check
  assertServiceRoleKeyIsNotPublic(); // structural guard
  const cfg = loadConfig(); // required config (incl. secrets)
  const envVars = resolveEnv(cfg); // every required Vercel var
  const vercel = buildVercel(cfg, envVars);
  const supabase = buildSupabase(cfg, envVars);
  buildModal(cfg); // disabled stub — TODO(spec 0009)

  const exports: Record<string, string> = {
    appUrl: cfg.domain ? `https://${cfg.domain}` : `https://${cfg.appName}.vercel.app`,
    vercelProject: cfg.appName,
    supabaseProjectRef: cfg.supabaseProjectRef,
    deployedFunctions: "provider-webhook, embed",
    modal: "disabled — spec 0009 not built",
  };

  return { cfg, envVars, vercel, supabase, exports };
}
