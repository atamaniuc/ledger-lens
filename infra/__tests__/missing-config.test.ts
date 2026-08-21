// A missing required variable must fail the build (fail `pulumi up`) rather
// than produce a broken deployment — this test proves it: with only partial
// config, buildInfra() throws and names the missing keys with the fix.

import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

describe("missing required config fails the build", () => {
  let program: any;

  beforeAll(async () => {
    await pulumi.runtime.setMocks(
      {
        newResource: (args) => ({ id: `${args.name}-id`, state: { ...args.inputs } }),
        call: (args) => args.inputs,
      },
      "ledgerlens-infra",
      "prod",
      false,
    );
    // Only the plaintext essentials — NO secrets configured.
    pulumi.runtime.setConfig("ledgerlens-infra:supabaseProjectRef", "nhvtzdufsjtlwidnfkzo");
    pulumi.runtime.setConfig("ledgerlens-infra:supabaseAnonKey", "anon-key");
    program = await import("../program.ts");
  });

  it("throws naming every missing required secret, before any resource is created", () => {
    let error: Error | undefined;
    try {
      program.buildInfra();
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    for (const key of [
      "vercelApiToken",
      "supabaseAccessToken",
      "dbPassword",
      "supabaseServiceRoleKey",
      "ingestionTriggerSecret",
      "webhookSharedSecret",
      "embedSharedSecret",
    ]) {
      expect(error!.message, `names ${key}`).toContain(key);
    }
    expect(error!.message).toContain("pulumi config set --secret");
  });

  it("throws when a required plaintext env var is missing", () => {
    // Drop the anon key from the config map; Config reads lazily, so the same
    // program instance re-validates against the new map.
    pulumi.runtime.setAllConfig({ "ledgerlens-infra:supabaseProjectRef": "nhvtzdufsjtlwidnfkzo" });
    let error: Error | undefined;
    try {
      program.buildInfra();
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain("supabaseAnonKey");
    expect(error!.message).toContain("pulumi config set supabaseAnonKey");
  });
});
