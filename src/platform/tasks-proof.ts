// Gated task state (spec 0017, D-63): a checked box in a live lane's
// tasks.md is a claim exactly like a `<!-- proof: ... -->` marker in prose —
// so it is checked the same way, through the same checkTarget every proof
// marker in this repo already goes through, rather than a second, divergent
// notion of "verified".
//
// Scope is deliberately narrow: only tasks.md files for specs currently
// listed as live tracks in specs/TRACKS.md are gated. Every already-shipped
// lane's tasks.md — checked boxes written before this rule existed — is left
// alone (spec 0017's Out of scope: "the gate applies going forward").
//
// The rules live in `harnessimo` (spec 0018); this file keeps the entry point
// and this project's conventions — `specs/` as the lane directory, `tasks.md`
// as the list.

import {
  checkTaskGate as coreCheckTaskGate,
  liveTrackSpecDirs as coreLiveTrackSpecDirs,
  verifyTaskGates as coreVerifyTaskGates,
} from "harnessimo";
import type { Problem, Resolver } from "./docs-proof";

const CONVENTIONS = { specsDir: "specs", taskFile: "tasks.md" };

/** Adapts this project's resolver to the shared one (see docs-proof.ts). */
function core(resolver: Resolver) {
  return {
    fileExists: (path: string) => resolver.fileExists(path),
    readFile: (path: string) => resolver.readFile(path),
    commandNames: (kind: string) => (kind === "task" ? resolver.taskNames() : null),
    migrationNames: () => resolver.migrationNames(),
  };
}

export function liveTrackSpecDirs(tracksText: string): string[] {
  return coreLiveTrackSpecDirs(tracksText, CONVENTIONS.specsDir);
}

export function checkTaskGate(text: string, filePath: string, resolver: Resolver): Problem[] {
  return coreCheckTaskGate(text, filePath, core(resolver));
}

export function verifyTaskGates(
  files: { path: string; text: string }[],
  tracksText: string,
  resolver: Resolver,
): Problem[] {
  return coreVerifyTaskGates(files, tracksText, core(resolver), CONVENTIONS);
}
