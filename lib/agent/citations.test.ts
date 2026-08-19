import { describe, expect, it } from "bun:test";
import { segmentAnswer, verifyCitations } from "./citations";

const context = { chunkIds: [12, 34], invoiceExternalIds: ["inv_00007"] };

describe("verifyCitations", () => {
  it("verifies ids that were actually retrieved", () => {
    const check = verifyCitations(
      "Terms are Net 30 [chunk:12], and invoice [invoice:inv_00007] is open.",
      context,
    );

    expect(check.citations).toEqual([
      { kind: "chunk", id: "12", verified: true },
      { kind: "invoice", id: "inv_00007", verified: true },
    ]);
    expect(check.hasUnverified).toBe(false);
  });

  it("flags an id that was never in a tool result", () => {
    // The whole point of US-02: a plausible-looking citation the model
    // invented is exactly what a reader would otherwise trust.
    const check = verifyCitations("Terms are Net 30 [chunk:999].", context);

    expect(check.citations).toEqual([{ kind: "chunk", id: "999", verified: false }]);
    expect(check.hasUnverified).toBe(true);
  });

  it("keeps the fabricated citation rather than deleting it", () => {
    // Removing it would hide the one signal that the answer may be invented.
    const answer = "Net 45 applies [invoice:inv_does_not_exist].";
    const check = verifyCitations(answer, context);

    expect(check.citations[0].id).toBe("inv_does_not_exist");
    expect(check.citations[0].verified).toBe(false);
  });

  it("reports an answer with no citations at all", () => {
    const check = verifyCitations("Payment terms are Net 30.", context);
    expect(check.hasNoCitations).toBe(true);
    expect(check.hasUnverified).toBe(false);
  });

  it("counts a repeated citation once", () => {
    const check = verifyCitations("[chunk:12] and again [chunk:12]", context);
    expect(check.citations).toHaveLength(1);
  });

  it("is case-insensitive about the marker and tolerant of spacing", () => {
    const check = verifyCitations("[Chunk: 34] [INVOICE:  inv_00007 ]", context);
    expect(check.citations.every((citation) => citation.verified)).toBe(true);
  });

  it("does not treat prose in brackets as a citation", () => {
    const check = verifyCitations("[see the appendix] and [note: something]", context);
    expect(check.citations).toHaveLength(0);
  });

  it("treats a chunk id as text, so 012 is not 12", () => {
    // Comparing as strings is deliberate: a model that emits a padded or
    // reformatted id has not cited the row it claims to.
    const check = verifyCitations("[chunk:012]", context);
    expect(check.citations[0].verified).toBe(false);
  });
});

describe("segmentAnswer", () => {
  const cited = verifyCitations("Net 30 [chunk:12] and [chunk:999].", context).citations;

  it("splits prose from markers and keeps the order", () => {
    const segments = segmentAnswer("Net 30 [chunk:12] and [chunk:999].", cited);

    expect(segments).toEqual([
      { kind: "text", text: "Net 30 " },
      { kind: "citation", citation: { kind: "chunk", id: "12", verified: true } },
      { kind: "text", text: " and " },
      { kind: "citation", citation: { kind: "chunk", id: "999", verified: false } },
      { kind: "text", text: "." },
    ]);
  });

  it("loses no text", () => {
    // The same invariant the chunker has: rendering must not be able to drop
    // part of an answer on the floor.
    const answer = "Before [invoice:inv_00007] middle [chunk:12] after";
    const rebuilt = segmentAnswer(answer, cited)
      .map((segment) =>
        segment.kind === "text"
          ? segment.text
          : `[${segment.citation.kind}:${segment.citation.id}]`,
      )
      .join("");

    expect(rebuilt).toBe(answer);
  });

  it("marks a marker missing from the citation list unverified", () => {
    const segments = segmentAnswer("[chunk:12]", []);
    expect(segments).toEqual([
      { kind: "citation", citation: { kind: "chunk", id: "12", verified: false } },
    ]);
  });

  it("returns an answer with no markers as a single text segment", () => {
    expect(segmentAnswer("Payment terms are Net 30.", [])).toEqual([
      { kind: "text", text: "Payment terms are Net 30." },
    ]);
  });
});
