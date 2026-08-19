// Citation verification — deterministic, and not a matter of the model's
// good behaviour.
//
// US-02: "responses cite chunk_id/invoice_id; a deterministic check confirms
// cited ids were actually in retrieved context, else flagged unverified."
// This is that check. An id the model produced that was never in a tool
// result this turn is *kept in the answer* and marked unverified, rather than
// deleted — silently removing it would hide the one signal that the answer
// may be invented.

export interface Citation {
  kind: "chunk" | "invoice";
  /** As written by the model: a chunk id as text, or an invoice external_id. */
  id: string;
  verified: boolean;
}

export interface CitationCheck {
  citations: Citation[];
  /** True when the answer cited at least one id that was never retrieved. */
  hasUnverified: boolean;
  /** True when the answer cited nothing at all. */
  hasNoCitations: boolean;
}

const CITATION_RE = /\[(chunk|invoice):\s*([^\]\s][^\]]*?)\s*\]/gi;

export interface RetrievedContext {
  chunkIds: readonly number[];
  invoiceExternalIds: readonly string[];
}

export function verifyCitations(answer: string, context: RetrievedContext): CitationCheck {
  const chunkIds = new Set(context.chunkIds.map(String));
  const invoiceIds = new Set(context.invoiceExternalIds);

  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const match of answer.matchAll(CITATION_RE)) {
    const kind = match[1].toLowerCase() as Citation["kind"];
    const id = match[2].trim();
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const verified = kind === "chunk" ? chunkIds.has(id) : invoiceIds.has(id);
    citations.push({ kind, id, verified });
  }

  return {
    citations,
    hasUnverified: citations.some((citation) => !citation.verified),
    hasNoCitations: citations.length === 0,
  };
}

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; citation: Citation };

/**
 * Splits an answer into prose and citation markers so a UI can render the
 * markers as something other than literal text.
 *
 * It re-scans with the same regex `verifyCitations` used rather than taking
 * the citation list as the source of truth, because the two must agree about
 * *where* in the string a marker sits. A marker that somehow escaped the
 * check is rendered unverified, which is the safe direction to be wrong in.
 */
export function segmentAnswer(
  answer: string,
  citations: readonly Citation[],
): AnswerSegment[] {
  const byKey = new Map(citations.map((citation) => [`${citation.kind}:${citation.id}`, citation]));
  const segments: AnswerSegment[] = [];
  let cursor = 0;

  for (const match of answer.matchAll(CITATION_RE)) {
    const kind = match[1].toLowerCase() as Citation["kind"];
    const id = match[2].trim();
    const start = match.index ?? 0;

    if (start > cursor) segments.push({ kind: "text", text: answer.slice(cursor, start) });
    segments.push({
      kind: "citation",
      citation: byKey.get(`${kind}:${id}`) ?? { kind, id, verified: false },
    });
    cursor = start + match[0].length;
  }

  if (cursor < answer.length) segments.push({ kind: "text", text: answer.slice(cursor) });
  return segments;
}
