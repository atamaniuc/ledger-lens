// Typed Pulumi stack configuration for the prod stack (spec 0010, D-01).
//
// Secrets are read with config.getSecret (values set via `pulumi config set
// --secret`, encrypted at rest, never committed). Every required value that
// is missing throws here — before a single resource is registered — naming
// ALL missing keys with the exact commands to fix them: a broken deployment
// is never produced.

import * as pulumi from "@pulumi/pulumi";

export interface InfraConfig {
  appName: string;
  framework: string;
  region: string;
  vercelTeamId?: string;
  /** Custom domain, e.g. "ledgerlens.app"; unset = Vercel default *.vercel.app. */
  domain?: string;
  supabaseProjectRef: string;
  supabaseProjectUrl: string;
  supabaseAnonKey: string;
  mockProviderSeed: string;
  mockProviderBaseUrl?: string;
  llmProvider?: string;
  anthropicModel?: string;
  groqModel?: string;
  nvidiaModel?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  vercelApiToken: pulumi.Output<string>;
  supabaseAccessToken: pulumi.Output<string>;
  dbPassword: pulumi.Output<string>;
  serviceRoleKey: pulumi.Output<string>;
  ingestionTriggerSecret: pulumi.Output<string>;
  webhookSharedSecret: pulumi.Output<string>;
  embedSharedSecret: pulumi.Output<string>;
  anthropicApiKey?: pulumi.Output<string>;
  groqApiKey?: pulumi.Output<string>;
  nvidiaApiKey?: pulumi.Output<string>;
  llmApiKey?: pulumi.Output<string>;
}

const config = new pulumi.Config();

export class MissingConfigError extends Error {
  constructor(missing: string[]) {
    super(
      "Missing required stack config — refusing to stand up a broken deployment:\n  - " +
        missing.join("\n  - ") +
        "\nFix: pulumi config set <key> <value>  (secrets: pulumi config set --secret <key> <value>)",
    );
    this.name = "MissingConfigError";
  }
}

/** Also fails at plan time when a required secret's value is empty. */
function nonEmptySecret(key: string, value: pulumi.Output<string>): pulumi.Output<string> {
  return value.apply((v) => {
    if (v === undefined || v.trim() === "") {
      throw new Error(`Config "${key}" is set but empty — Fix: pulumi config set --secret ${key} <value>`);
    }
    return v;
  });
}

export function loadConfig(): InfraConfig {
  const missing: string[] = [];
  const pln = (key: string, hint: string): string | undefined => {
    const v = config.get(key);
    if (v === undefined || v.trim() === "") {
      missing.push(`${key} — ${hint} (Fix: pulumi config set ${key} <value>)`);
      return undefined;
    }
    return v;
  };
  const sec = (key: string, hint: string): pulumi.Output<string> | undefined => {
    const v = config.getSecret(key);
    if (v === undefined) {
      missing.push(`${key} — ${hint} (Fix: pulumi config set --secret ${key} <value>)`);
      return undefined;
    }
    return nonEmptySecret(key, v);
  };

  const supabaseProjectRef = pln(
    "supabaseProjectRef",
    "the hosted Supabase project ref (dashboard > Settings > General, e.g. nhvtzdufsjtlwidnfkzo)",
  );
  const supabaseAnonKey = pln(
    "supabaseAnonKey",
    "the project's anon key (dashboard > Settings > API). Public by design — RLS is the boundary, not this key",
  );
  const vercelApiToken = sec("vercelApiToken", "Vercel access token (vercel.com/account/tokens)");
  const supabaseAccessToken = sec(
    "supabaseAccessToken",
    "Supabase personal access token (dashboard > Account > Access Tokens)",
  );
  const dbPassword = sec(
    "dbPassword",
    "hosted Postgres password — supabase db push needs it to connect non-interactively",
  );
  const serviceRoleKey = sec(
    "supabaseServiceRoleKey",
    "service-role key (dashboard > Settings > API). Server-only; never in a NEXT_PUBLIC_* variable",
  );
  const ingestionTriggerSecret = sec(
    "ingestionTriggerSecret",
    "x-ingestion-secret required by POST /api/ingestion/run and /api/data-quality/run",
  );
  const webhookSharedSecret = sec(
    "webhookSharedSecret",
    "x-webhook-secret the provider-webhook Edge Function checks; must match its copy in supabase/.env",
  );
  const embedSharedSecret = sec(
    "embedSharedSecret",
    "x-embed-secret the embed Edge Function checks; must match its copy in supabase/.env",
  );

  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }

  return {
    appName: config.get("appName") ?? "ledgerlens",
    framework: config.get("framework") ?? "nextjs",
    region: config.get("region") ?? "iad1",
    vercelTeamId: config.get("vercelTeamId") || undefined,
    domain: config.get("domain") || undefined,
    supabaseProjectRef: supabaseProjectRef!,
    supabaseProjectUrl: `https://${supabaseProjectRef}.supabase.co`,
    supabaseAnonKey: supabaseAnonKey!,
    mockProviderSeed: config.get("mockProviderSeed") ?? "42",
    mockProviderBaseUrl: config.get("mockProviderBaseUrl") || undefined,
    llmProvider: config.get("llmProvider") || undefined,
    anthropicModel: config.get("anthropicModel") || undefined,
    groqModel: config.get("groqModel") || undefined,
    nvidiaModel: config.get("nvidiaModel") || undefined,
    llmBaseUrl: config.get("llmBaseUrl") || undefined,
    llmModel: config.get("llmModel") || undefined,
    vercelApiToken: vercelApiToken!,
    supabaseAccessToken: supabaseAccessToken!,
    dbPassword: dbPassword!,
    serviceRoleKey: serviceRoleKey!,
    ingestionTriggerSecret: ingestionTriggerSecret!,
    webhookSharedSecret: webhookSharedSecret!,
    embedSharedSecret: embedSharedSecret!,
    anthropicApiKey: config.getSecret("anthropicApiKey"),
    groqApiKey: config.getSecret("groqApiKey"),
    nvidiaApiKey: config.getSecret("nvidiaApiKey"),
    llmApiKey: config.getSecret("llmApiKey"),
  };
}
