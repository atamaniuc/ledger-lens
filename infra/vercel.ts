// Native Pulumi tier (spec 0010, D-01): the Vercel project, its environment
// variables and its domain, through the @pulumiverse/vercel provider. These
// are real resources: full dependency graph and drift detection, unlike the
// command-wrapped Supabase steps.

import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";
import type { InfraConfig } from "./config.js";
import type { ResolvedEnvVar } from "./env.js";

export interface VercelResources {
  provider: vercel.Provider;
  project: vercel.Project;
  envVars: vercel.ProjectEnvironmentVariable[];
  /** Present only when config `domain` is non-empty. */
  domain?: vercel.ProjectDomain;
}

export function buildVercel(cfg: InfraConfig, envVars: ResolvedEnvVar[]): VercelResources {
  // The provider carries the access token (a Pulumi secret from stack config)
  // and the team — the only place the credential enters the native tier.
  const provider = new vercel.Provider("vercel", {
    apiToken: cfg.vercelApiToken,
    ...(cfg.vercelTeamId ? { team: cfg.vercelTeamId } : {}),
  });
  const opts: pulumi.CustomResourceOptions = { provider };

  const project = new vercel.Project(
    "ledgerlens",
    {
      name: cfg.appName,
      framework: cfg.framework,
    },
    opts,
  );

  const resources = envVars.map(
    ({ spec, value }) =>
      new vercel.ProjectEnvironmentVariable(
        `env-${spec.key}`,
        {
          key: spec.key,
          value,
          projectId: project.id,
          targets: ["production"],
          // Secret values are marked sensitive on Vercel: write-only after
          // creation, never readable through the API or dashboard.
          sensitive: spec.secret,
          comment: spec.description,
        },
        opts,
      ),
  );

  const domain = cfg.domain
    ? new vercel.ProjectDomain("ledgerlens-domain", { projectId: project.id, domain: cfg.domain }, opts)
    : undefined;

  return { provider, project, envVars: resources, domain };
}
