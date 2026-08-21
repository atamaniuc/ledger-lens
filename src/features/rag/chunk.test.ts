import { describe, expect, it } from "vitest";
import {
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNK_CHARS,
  chunkText,
  hashText,
  normalize,
  renderInvoice,
  splitIntoChunks,
} from "./chunk";

const sentence = (n: number) => `Sentence number ${n} says something about invoices and terms.`;
const paragraph = (count: number) =>
  Array.from({ length: count }, (_, i) => sentence(i)).join(" ");

describe("splitIntoChunks", () => {
  it("keeps a short text as a single chunk", () => {
    expect(splitIntoChunks("Net 30 from the invoice date.")).toEqual([
      "Net 30 from the invoice date.",
    ]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   \n\t ")).toEqual([]);
  });

  it("never exceeds the chunk ceiling", () => {
    for (const chunk of splitIntoChunks(paragraph(80))) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it("overlaps consecutive chunks", () => {
    // A fact that straddles a boundary has to stay retrievable whole, which
    // is the only reason the overlap exists.
    const chunks = splitIntoChunks(paragraph(60));
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0].slice(-CHUNK_OVERLAP_CHARS);
    const overlapping = tail.split(" ").some((word) => word.length > 3 && chunks[1].includes(word));
    expect(overlapping).toBe(true);
  });

  it("is deterministic — the same text yields the same boundaries", () => {
    // `task index` decides what to re-embed by hash. A chunker that drifted
    // would re-embed the whole corpus on every run.
    const text = paragraph(40);
    expect(splitIntoChunks(text)).toEqual(splitIntoChunks(text));
  });

  it("is insensitive to whitespace noise", () => {
    const text = paragraph(10);
    const noisy = text.replace(/ /g, "  ").replace(/\./g, ".\n");
    expect(splitIntoChunks(noisy)).toEqual(splitIntoChunks(text));
  });

  it("loses no text, whatever the punctuation", () => {
    // The regression that produced this test: the first tokenizer matched
    // sentences with a regex, and a regex skips what it cannot match. A
    // decimal point ("interest at 1.5 percent per month.") made it drop the
    // words in front of it, so `interest` vanished from the index while the
    // chunk still read as ordinary prose. Silent loss, plausible output.
    const text =
      "Invoices are issued on Net 30 terms. Unpaid invoices accrue interest at 1.5 percent per month. " +
      "Escalate to collections after 60 days. Contact a.brown@example.com or ext. 4021 for exceptions!? " +
      "Reference numbers look like INV-1.2 and must not be split.";
    const joined = splitIntoChunks(text).join(" ");
    for (const word of ["interest", "1.5", "a.brown@example.com", "ext.", "INV-1.2", "collections"]) {
      expect(joined).toContain(word);
    }
    // Nothing dropped: every non-space character survives the round trip.
    expect(joined.replace(/\s/g, "")).toContain(text.replace(/\s/g, ""));
  });

  it("does not treat a decimal point as a sentence end", () => {
    expect(splitIntoChunks("Interest is 1.5 percent monthly.")).toEqual([
      "Interest is 1.5 percent monthly.",
    ]);
  });

  it("hard-cuts a single sentence longer than the ceiling", () => {
    const chunks = splitIntoChunks("x".repeat(2500), { maxChars: 900, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(900);
    expect(chunks.join("").replace(/ /g, "").length).toBeGreaterThanOrEqual(2500);
  });

  it("makes progress when the overlap alone fills a chunk", () => {
    // The carried tail can be too long to leave room for the sentence that
    // triggered the flush. Without the guard for that, the same tail would
    // be emitted forever.
    const chunks = splitIntoChunks(paragraph(20), { maxChars: 120, overlapChars: 110 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks).size).toBe(chunks.length);
  });

  it("rejects an overlap that is not smaller than the chunk", () => {
    expect(() => splitIntoChunks("text", { maxChars: 100, overlapChars: 100 })).toThrow();
  });
});

describe("chunkText", () => {
  it("numbers chunks from zero and hashes each one", async () => {
    const chunks = await chunkText(paragraph(30));
    expect(chunks[0].chunk_no).toBe(0);
    expect(chunks.map((c) => c.chunk_no)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) expect(chunk.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives identical content identical hashes", async () => {
    const [a] = await chunkText("Net 30 from the invoice date.");
    const [b] = await chunkText("Net 30 from the invoice date.");
    expect(a.content_hash).toBe(b.content_hash);
  });
});

describe("hashText", () => {
  it("matches the SQL seed's digest of the same string", async () => {
    // encode(sha256(convert_to('abc','UTF8')),'hex')
    expect(await hashText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("normalize", () => {
  it("collapses whitespace and trims", () => {
    expect(normalize("  a \n\n b\tc  ")).toBe("a b c");
  });
});

describe("renderInvoice", () => {
  const base = {
    external_id: "INV-2043",
    customer: "Northwind Traders",
    amount_cents: 120_000,
    currency: "usd",
    status: "open",
    issued_at: "2026-03-01",
    paid_at: null,
  };

  it("names the things a person would type", () => {
    const text = renderInvoice(base);
    expect(text).toContain("INV-2043");
    expect(text).toContain("Northwind Traders");
    expect(text).toContain("1,200.00 USD");
    expect(text).toContain("Issued on 2026-03-01");
  });

  it("mentions the payment date only when it is paid", () => {
    expect(renderInvoice(base)).not.toContain("paid on");
    expect(renderInvoice({ ...base, status: "paid", paid_at: "2026-03-20" })).toContain(
      "paid on 2026-03-20",
    );
  });

  it("says so when a paid invoice has no payment date", () => {
    expect(renderInvoice({ ...base, status: "paid", paid_at: null })).toContain(
      "no payment date recorded",
    );
  });

  it("is one chunk", async () => {
    expect(await chunkText(renderInvoice(base))).toHaveLength(1);
  });
});
