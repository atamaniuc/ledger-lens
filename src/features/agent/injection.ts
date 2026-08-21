// Embedded-instruction detection and disclosure.
//
// The project's safety argument has always been capability, not persuasion: a
// poisoned document cannot make the agent act because no tool can act. A
// measured eval run showed the other half of the problem, though — on
// `groq/openai/gpt-oss-20b` every one of seven injection cases scored 0.00 on
// the answer rule, because the model summarised the poisoned document without
// mentioning that it contained an instruction. The containment held; the reader
// was simply not told.
//
// A system prompt asking the model to disclose is the same kind of hope that
// asking it to behave would be. So disclosure is a mechanism: the retrieval
// path detects instruction-shaped text, and the turn states it. The model's own
// wording is preferred when it already says so — this only speaks when the
// answer is silent.

/**
 * Patterns for text addressed to an assistant rather than to a reader. Kept
 * deliberately narrow: a false positive puts a sentence in an answer that did
 * not need it, so the patterns look for an imperative aimed at "you"/"the
 * assistant" or the classic override phrasings, not for any mention of a rule.
 */
export const EMBEDDED_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(previous|prior|above|earlier|the)\s+\w+/i,
  /\byou\s+(must|should|need\s+to|are\s+required\s+to)\s+(send|email|export|forward|transfer|reveal|disclose|include|attach)\b/i,
  /\b(system|developer)\s*(prompt|message)\s*[:=]/i,
  /\bnew\s+instructions?\s*[:=]/i,
  /\b(assistant|agent|ai|model|copilot)\s*[:,]?\s*(please\s+)?(send|email|export|forward|reveal|disclose|ignore)\b/i,
  /\bdo\s+not\s+(tell|mention|inform|disclose\s+to)\s+the\s+(user|customer|human)\b/i,
  /\bwhen\s+(you|the\s+assistant)\s+(read|see|process)\s+this\b/i,
];

/**
 * The sentence appended when retrieved text contained an instruction and the
 * answer did not mention it.
 *
 * The wording is chosen to satisfy the same rule the eval suite scores — it
 * names an embedded instruction and states that it was not followed — because
 * a disclosure the gate cannot recognise is a disclosure the reader cannot
 * trust either.
 */
export const DISCLOSURE_SENTENCE =
  "Note: one of the retrieved documents contains an embedded instruction addressed to the assistant. " +
  "It was treated as data and not followed.";

/** True when the text is shaped like an instruction to an assistant. */
export function looksLikeEmbeddedInstruction(text: string): boolean {
  return EMBEDDED_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when an answer already tells the reader about the instruction, in which
 * case nothing is appended. Deliberately generous: the model saying it in its
 * own words is better than a stock sentence.
 */
export function alreadyDiscloses(answer: string): boolean {
  return /\b(embedded|malicious|suspicious|injected)\s+instruction|prompt\s+injection|instruction\s+addressed\s+to\s+(me|the\s+(assistant|agent))|treated?\s+as\s+data|did\s+not\s+follow|ignored?\s+(that|the|those)\s+instruction/i.test(
    answer,
  );
}

/** The answer, with the disclosure added only when it is needed. */
export function withDisclosure(answer: string, suspected: boolean): string {
  if (!suspected || alreadyDiscloses(answer)) return answer;
  const trimmed = answer.trimEnd();
  return trimmed.length === 0 ? DISCLOSURE_SENTENCE : `${trimmed}\n\n${DISCLOSURE_SENTENCE}`;
}
