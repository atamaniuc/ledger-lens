// LedgerLens deployable surface (spec 0010, D-01) — the claim README.md and
// docs/RUNBOOK.md already make: one `pulumi up` stands up the whole
// surface. Vercel is native; Supabase (db push + functions deploy) is
// command-wrapped; Modal is a disabled stub (spec 0009).

import { buildInfra } from "./program.ts";

const built = buildInfra();

// Public values only — never export a secret (program.ts exports is the one
// place stack outputs are defined; tests assert no secret value lands there).
export const appUrl = built.exports.appUrl;
export const vercelProject = built.exports.vercelProject;
export const supabaseProjectRef = built.exports.supabaseProjectRef;
export const deployedFunctions = built.exports.deployedFunctions;
export const modal = built.exports.modal;
