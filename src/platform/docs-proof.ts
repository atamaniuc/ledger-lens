// Every claim in the human documentation carries a machine-checked proof.
//
// The disease this cures: for weeks README.md said "all deployable
// infrastructure is stood up through a single Pulumi program in infra/" while
// infra/ did not exist, and "LLM-as-judge groundedness blocks the merge" three
// screens above a TODO admitting it was not computed. Ten such claims came out
// of one audit (D-01..D-10). Prose cannot be trusted to stay true on its own,
// so the documents name their evidence and a gate fails when the evidence is
// gone.
//
// Marker syntax, in an HTML comment so it never renders:
//
//   <!-- proof: src/features/rag/search.ts -->                   the file exists
//   <!-- proof: src/features/rag/search.ts:searchChunks -->       ...and contains that text
//   <!-- proof: tests/rls-coverage.spec.ts#every table in public has row level security enabled -->
//   <!-- proof: task check-infra -->                             the Taskfile defines that task
//   <!-- proof: migration:20260821110000 -->                      a migration with that prefix exists
//
// The rules themselves now live in `harnessimo`, shared with the other
// repository that grew half of this idea (spec 0018). What stays here is what
// is specific to this project: which documents must carry evidence at all, and
// the fact that a bare command marker means a Taskfile task. Keeping this file
// means `task check`, the CLI in scripts/verify-docs.ts and the unit tests in
// docs-proof.test.ts all keep their entry point — the rule has one
// implementation, not the wrapper.

import {
  checkHandoffRefs as coreCheckHandoffRefs,
  checkTracks as coreCheckTracks,
  checkTarget as coreCheckTarget,
  findMarkers as coreFindMarkers,
  verifyProofs,
  type Problem as CoreProblem,
  type Resolver as CoreResolver,
} from "harnessimo";

/** Documents whose claims must be evidenced once the gate runs in strict mode. */
const MUST_CARRY_PROOF = ["README.md", "docs/ARCHITECTURE.md"];

export type Problem = CoreProblem;

/**
 * This project's resolver shape, kept as it was: a marker's command prefix here
 * is always `task`, because the Taskfile is the only command surface (AGENTS.md
 * §Command surface).
 */
export interface Resolver {
  fileExists(path: string): boolean;
  readFile(path: string): string;
  taskNames(): string[];
  migrationNames(): string[];
}

/** Adapts this project's resolver to the shared one. */
function core(resolver: Resolver): CoreResolver {
  return {
    fileExists: (path) => resolver.fileExists(path),
    readFile: (path) => resolver.readFile(path),
    commandNames: (kind) => (kind === "task" ? resolver.taskNames() : null),
    migrationNames: () => resolver.migrationNames(),
  };
}

export function checkTarget(target: string, resolver: Resolver): string | null {
  return coreCheckTarget(target, core(resolver));
}

export function findMarkers(text: string): { line: number; target: string }[] {
  return coreFindMarkers(text);
}

export function checkTracks(text: string, resolver: Resolver): Problem[] {
  return coreCheckTracks(text, core(resolver), "specs/TRACKS.md");
}

export function checkHandoffRefs(
  text: string,
  resolver: Resolver,
  filePath: string,
): Problem[] {
  return coreCheckHandoffRefs(text, core(resolver), filePath, "specs/TRACKS-LOG.md");
}

export function verify(
  files: { path: string; text: string }[],
  resolver: Resolver,
  strict: boolean,
): Problem[] {
  const shared = core(resolver);
  const problems = verifyProofs(files, shared, { strict, mustCarryProof: MUST_CARRY_PROOF });
  for (const file of files) {
    problems.push(...coreCheckHandoffRefs(file.text, shared, file.path, "specs/TRACKS-LOG.md"));
    if (file.path === "specs/TRACKS.md") {
      problems.push(...coreCheckTracks(file.text, shared, file.path));
    }
  }
  return problems;
}
