import { describe, expect, it } from "vitest";
import { checkTarget, findMarkers, verify, type Resolver } from "./docs-proof";

// The gate that keeps the documentation honest needs its own gate: a checker
// that cannot fail is a checker nobody should believe (the same argument that
// made a skipped eval red — D-24).

const resolver: Resolver = {
  fileExists: (path) => ["src/real.ts", "tests/some.spec.ts", "README.md"].includes(path),
  readFile: (path) =>
    path === "src/real.ts"
      ? "export function searchChunks() {}"
      : 'it("every table has RLS", () => {})',
  taskNames: () => ["check", "check-infra", "e2e"],
  migrationNames: () => ["20260821110000_scheduler_locks_and_cron.sql"],
};

describe("findMarkers", () => {
  it("finds a marker and its line, and ignores ordinary prose", () => {
    const text = ["# Title", "A claim. <!-- proof: src/real.ts -->", "no marker here"].join("\n");
    expect(findMarkers(text)).toEqual([{ line: 2, target: "src/real.ts" }]);
  });

  it("ignores the syntax examples the specs and AGENTS.md contain", () => {
    // Those documents teach the marker syntax, and their illustrations are
    // written as markers. Placeholder punctuation is what tells them apart.
    const text = [
      "<!-- proof: path[:symbol|#test] -->",
      "<!-- proof: ... -->",
      "<!-- proof: src/real.ts -->",
    ].join("\n");
    expect(findMarkers(text).map((m) => m.target)).toEqual(["src/real.ts"]);
  });

  it("finds several markers on one line", () => {
    const text = "<!-- proof: src/real.ts --> and <!-- proof: task check -->";
    expect(findMarkers(text).map((m) => m.target)).toEqual(["src/real.ts", "task check"]);
  });
});

describe("checkTarget", () => {
  it("accepts an existing file and rejects a missing one", () => {
    expect(checkTarget("src/real.ts", resolver)).toBeNull();
    expect(checkTarget("src/gone.ts", resolver)).toMatch(/does not exist/);
  });

  it("accepts a symbol the file contains and rejects one it does not", () => {
    expect(checkTarget("src/real.ts:searchChunks", resolver)).toBeNull();
    expect(checkTarget("src/real.ts:citableIds", resolver)).toMatch(/does not contain/);
  });

  it("accepts a test name the spec contains", () => {
    expect(checkTarget("tests/some.spec.ts#every table has RLS", resolver)).toBeNull();
    expect(checkTarget("tests/some.spec.ts#a test that was deleted", resolver)).toMatch(
      /does not contain/,
    );
  });

  it("accepts a task the Taskfile defines and rejects one it does not", () => {
    expect(checkTarget("task check-infra", resolver)).toBeNull();
    expect(checkTarget("task deploy-everything", resolver)).toMatch(/no task/);
  });

  it("accepts a migration by timestamp prefix", () => {
    expect(checkTarget("migration:20260821110000", resolver)).toBeNull();
    expect(checkTarget("migration:19990101000000", resolver)).toMatch(/no migration/);
  });
});

describe("verify", () => {
  it("passes a document whose every marker resolves", () => {
    const files = [{ path: "docs/x.md", text: "claim <!-- proof: task check -->" }];
    expect(verify(files, resolver, false)).toEqual([]);
  });

  it("reports the file, line, target and reason for each broken marker", () => {
    const files = [
      { path: "docs/x.md", text: "line one\nclaim <!-- proof: infra/index.ts -->" },
    ];
    const problems = verify(files, resolver, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: "docs/x.md", line: 2, target: "infra/index.ts" });
    expect(problems[0].reason).toMatch(/does not exist/);
  });

  it("in strict mode, a document that must carry proof and carries none is a failure", () => {
    // This is the rule that would have caught the Pulumi claim: prose with no
    // evidence at all, rather than prose whose evidence went stale.
    const files = [{ path: "README.md", text: "# LedgerLens\nOne command deploys everything." }];
    expect(verify(files, resolver, false)).toEqual([]);
    const strict = verify(files, resolver, true);
    expect(strict).toHaveLength(1);
    expect(strict[0].reason).toMatch(/carries no proof marker/);
  });
});