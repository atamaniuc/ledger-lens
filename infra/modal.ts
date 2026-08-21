// Modal transcription service — spec 0009 is NOT built yet, so there is
// deliberately nothing to stand up and this module registers NO resources.
//
// TODO(spec 0009): when the Modal service exists, implement a command-wrapped
// `modal deploy` step here (local.Command, trigger = hash of the modal/
// sources, dependsOn the Supabase schema) and call it from buildInfra() in
// program.ts. Do not invent resources for something that is not built.

import type { InfraConfig } from "./config.ts";

export function buildModal(_cfg: InfraConfig): void {
  // Disabled stub — see TODO above. No resources are registered.
}
