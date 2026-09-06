import { describe, expect, it } from "vitest";
import type { Resolver } from "./docs-proof";
import { checkTaskGate, liveTrackSpecDirs, verifyTaskGates } from "./tasks-proof";

// D-63: a checked box is a claim, and a checker that trusts the checkbox
// instead of the marker it names is exactly the defect this gate exists to
// remove — so this checker needs its own tests, the same argument
// docs-proof.test.ts makes for the proof-marker gate itself.

const resolver: Resolver = {
  fileExists: (path) => ["tests/real.spec.ts"].includes(path),
  readFile: (path) => (path === "tests/real.spec.ts" ? 'it("does the thing", () => {})' : ""),
  taskNames: () => ["check"],
  migrationNames: () => [],
};

describe("liveTrackSpecDirs", () => {
  it("extracts a spec dir from a handoff link", () => {
    const text = [
      "# Work tracks",
      "- **Hosted deploy** — none — blocked (on TOKEN)",
      "- **Vision** — [handoff](specs/0016-vision-layout-ingestion/handoff.md) — paused",
    ].join("\n");
    expect(liveTrackSpecDirs(text)).toEqual(["specs/0016-vision-layout-ingestion"]);
  });

  it("returns nothing for a track with no handoff link", () => {
    expect(liveTrackSpecDirs("- **Hosted deploy** — none — blocked")).toEqual([]);
  });

  it("dedupes a dir linked more than once", () => {
    const text = [
      "- **A** — [handoff](specs/0016-x/handoff.md) — active",
      "- **B** — [spec](specs/0016-x/spec.md) · [handoff](specs/0016-x/handoff.md) — active",
    ].join("\n");
    expect(liveTrackSpecDirs(text)).toEqual(["specs/0016-x"]);
  });
});

describe("checkTaskGate", () => {
  it("passes a checked task whose proof marker resolves", () => {
    const text = "- [x] **T1** does the thing <!-- proof: tests/real.spec.ts -->";
    expect(checkTaskGate(text, "specs/0016-x/tasks.md", resolver)).toEqual([]);
  });

  it("flags a checked task that names no check at all", () => {
    const text = "- [x] **T1** does the thing, trust me";
    const problems = checkTaskGate(text, "specs/0016-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: "specs/0016-x/tasks.md", line: 1, target: "(none)" });
    expect(problems[0].reason).toMatch(/names no executable check/);
  });

  it("flags a checked task whose named check does not resolve", () => {
    const text = "- [x] **T1** does the thing <!-- proof: tests/gone.spec.ts -->";
    const problems = checkTaskGate(text, "specs/0016-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 1, target: "tests/gone.spec.ts" });
    expect(problems[0].reason).toMatch(/checked task's proof failed.*does not exist/);
  });

  it("does not mistake an illustrative marker (docs about the syntax) for a real one", () => {
    // A task describing this very gate can legitimately write the marker
    // syntax as an example — `<!-- proof: ... -->` — same rule docs-proof.ts
    // applies to README/AGENTS.md examples via isSyntaxExample.
    const text = [
      "- [x] **T1** require a `<!-- proof: ... -->` marker on each checked line",
      "      <!-- proof: tests/real.spec.ts -->",
    ].join("\n");
    expect(checkTaskGate(text, "specs/0017-x/tasks.md", resolver)).toEqual([]);
  });

  it("flags a checked task whose only marker is the illustrative example", () => {
    const text = "- [x] **T1** require a `<!-- proof: ... -->` marker";
    const problems = checkTaskGate(text, "specs/0017-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0].target).toBe("(none)");
  });

  it("ignores an unchecked task, whatever it claims", () => {
    const text = "- [ ] **T1** not done yet";
    expect(checkTaskGate(text, "specs/0016-x/tasks.md", resolver)).toEqual([]);
  });

  it("finds the marker on a wrapped continuation line, not just the [x] line", () => {
    // Real tasks.md entries wrap (see this repo's own specs/*/tasks.md) — a
    // marker two lines below the checkbox, indented as a continuation, is
    // still this item's marker, not a stray line the checker misses.
    const text = [
      "- [x] **T1** a task description that runs long enough",
      "      to wrap onto a continuation line, which is where",
      "      the marker actually lives <!-- proof: tests/real.spec.ts -->",
    ].join("\n");
    expect(checkTaskGate(text, "specs/0016-x/tasks.md", resolver)).toEqual([]);
  });

  it("attributes a wrapped item's problem to its [x] line, not the continuation", () => {
    const text = [
      "- [x] **T1** a task description that runs long enough",
      "      to wrap, with no proof marker anywhere in the item",
    ].join("\n");
    const problems = checkTaskGate(text, "specs/0016-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(1);
  });

  it("does not leak a marker from one item into the next", () => {
    const text = [
      "- [x] **T1** proved <!-- proof: tests/real.spec.ts -->",
      "- [x] **T2** not proved",
    ].join("\n");
    const problems = checkTaskGate(text, "specs/0016-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(2);
  });

  it("reports every checked line, with correct line numbers", () => {
    const text = [
      "# Tasks",
      "- [x] **T1** ok <!-- proof: tests/real.spec.ts -->",
      "- [x] **T2** bad",
    ].join("\n");
    const problems = checkTaskGate(text, "specs/0016-x/tasks.md", resolver);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(3);
  });
});

describe("verifyTaskGates", () => {
  const tracksText = "- **Vision** — [handoff](specs/0016-x/handoff.md) — paused";

  it("checks a tasks.md that belongs to a live track", () => {
    const files = [
      { path: "specs/0016-x/tasks.md", text: "- [x] **T1** claim, no marker" },
    ];
    const problems = verifyTaskGates(files, tracksText, resolver);
    expect(problems).toHaveLength(1);
  });

  it("skips a tasks.md whose spec is not a live track — the grandfather rule", () => {
    const files = [
      { path: "specs/0001-old/tasks.md", text: "- [x] **T1** claim, no marker, shipped years ago" },
    ];
    expect(verifyTaskGates(files, tracksText, resolver)).toEqual([]);
  });

  it("ignores a file that isn't a tasks.md, even under a live track dir", () => {
    const files = [{ path: "specs/0016-x/spec.md", text: "- [x] not a task list" }];
    expect(verifyTaskGates(files, tracksText, resolver)).toEqual([]);
  });
});
