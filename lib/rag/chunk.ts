// Deterministic chunking. No model call, no randomness, no clock: the same
// text always produces the same chunks with the same hashes.
//
// That property is load-bearing twice over. `task index` decides what to
// re-embed by comparing hashes, so a chunker that drifted would re-embed the
// whole corpus on every run; and Stage 6's eval set is scored against chunk
// ids, which are only stable if the boundaries are.

export const MAX_CHUNK_CHARS = 900;
export const CHUNK_OVERLAP_CHARS = 150;

export interface Chunk {
  chunk_no: number;
  content: string;
  content_hash: string;
}

/** SHA-256 of the UTF-8 text, hex. Matches `encode(sha256(convert_to(t,'UTF8')),'hex')` in SQL. */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Collapses runs of whitespace so trailing-space edits do not re-chunk a document. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Splits on sentence ends, keeping the terminator with its sentence.
 *
 * Scanned rather than matched with a regex, and the difference is not
 * stylistic. A `/[^.!?]+[.!?]+(\s|$)/g` match silently *skips* any span it
 * cannot match — so "accrue interest at 1.5 percent per month." lost
 * everything up to the decimal point, and the word `interest` disappeared
 * from the index while the chunk still looked plausible. Every character of
 * the input leaves this function in exactly one part; `chunkText` has a test
 * that says so.
 *
 * A terminator ends a sentence only when a space follows it, which is what
 * keeps decimals and `INV-1.2` style identifiers intact — whitespace is
 * already collapsed by `normalize`, so a space is the only thing to check.
 *
 * A sentence longer than `maxChars` on its own is hard-cut: rare in prose,
 * and the alternative is a chunk the embedder would truncate silently.
 */
function sentences(text: string, maxChars: number): string[] {
  const out: string[] = [];

  const push = (raw: string) => {
    const part = raw.trim();
    if (part.length === 0) return;
    if (part.length <= maxChars) {
      out.push(part);
      return;
    }
    for (let i = 0; i < part.length; i += maxChars) out.push(part.slice(i, i + maxChars));
  };

  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!".!?".includes(text[i])) continue;
    // Take a run of terminators together ("wait!?") so the split lands after
    // all of them rather than between them.
    let end = i;
    while (end + 1 < text.length && ".!?".includes(text[end + 1])) end++;

    const next = text[end + 1];
    if (next === undefined) {
      push(text.slice(start, end + 1));
      start = end + 1;
      i = end;
      continue;
    }
    if (next === " ") {
      push(text.slice(start, end + 1));
      start = end + 2;
      i = end + 1;
      continue;
    }
    // Mid-token: a decimal point or an identifier, not a sentence end.
    i = end;
  }
  if (start < text.length) push(text.slice(start));

  return out;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/**
 * Packs sentences greedily up to `maxChars`, then starts the next chunk with
 * enough trailing sentences to cover `overlapChars`. The overlap is why a fact
 * that straddles a boundary is still retrievable whole.
 */
export function splitIntoChunks(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? MAX_CHUNK_CHARS;
  const overlapChars = opts.overlapChars ?? CHUNK_OVERLAP_CHARS;
  if (maxChars < 1) throw new Error("maxChars must be at least 1");
  if (overlapChars >= maxChars) throw new Error("overlapChars must be smaller than maxChars");

  const normalized = normalize(text);
  if (normalized.length === 0) return [];

  const parts = sentences(normalized, maxChars);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join(" "));
    // Carry the tail of this chunk into the next one, sentence by sentence,
    // until the overlap budget is met.
    const carried: string[] = [];
    let carriedLength = 0;
    for (let i = current.length - 1; i >= 0 && carriedLength < overlapChars; i--) {
      carried.unshift(current[i]);
      carriedLength += current[i].length + 1;
    }
    // All of it carrying over would mean no progress, so the last sentence
    // alone is never enough to start a chunk with.
    current = carried.length < current.length ? carried : [];
    currentLength = current.reduce((n, s) => n + s.length + 1, 0);
  };

  for (const part of parts) {
    if (currentLength > 0 && currentLength + part.length + 1 > maxChars) {
      flush();
      // The carried overlap can be too long to leave room for the sentence
      // that triggered the flush. Dropping it is what keeps the loop moving
      // instead of emitting the same tail twice.
      if (currentLength > 0 && currentLength + part.length + 1 > maxChars) {
        current = [];
        currentLength = 0;
      }
    }
    current.push(part);
    currentLength += part.length + 1;
  }
  if (current.length > 0) chunks.push(current.join(" "));

  return chunks;
}

/** Chunks text and hashes each chunk, ready to be compared against what is stored. */
export async function chunkText(text: string, opts: ChunkOptions = {}): Promise<Chunk[]> {
  const contents = splitIntoChunks(text, opts);
  return Promise.all(
    contents.map(async (content, index) => ({
      chunk_no: index,
      content,
      content_hash: await hashText(content),
    })),
  );
}

export interface InvoiceForChunking {
  external_id: string;
  customer: string;
  amount_cents: number;
  currency: string;
  status: string;
  issued_at: string;
  paid_at: string | null;
}

/**
 * One invoice, one chunk of plain prose. Retrieval over the money has to
 * compete with `list_invoices`, so the rendering names the things a person
 * would actually type — the identifier, the customer, the status — rather
 * than being a serialized row.
 */
export function renderInvoice(invoice: InvoiceForChunking): string {
  const amount = (invoice.amount_cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const paid =
    invoice.status === "paid" && invoice.paid_at
      ? ` It was paid on ${invoice.paid_at}.`
      : invoice.status === "paid"
        ? " It is marked paid with no payment date recorded."
        : "";
  return (
    `Invoice ${invoice.external_id} for customer ${invoice.customer}. ` +
    `Amount ${amount} ${invoice.currency.toUpperCase()}. ` +
    `Status ${invoice.status}. Issued on ${invoice.issued_at}.${paid}`
  );
}
