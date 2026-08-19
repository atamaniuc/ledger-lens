// The price table, versioned in the repository.
//
// ADR 0009: cost is computed at write time and stored on the row, so a
// historical `llm_calls` row keeps the price actually paid. Deriving cost at
// read time from current pricing would silently rewrite last month's numbers
// the next time Anthropic changes a rate — which, in a project whose whole
// argument is that the numbers can be trusted, is the wrong failure.
//
// Rates are US dollars per million tokens, from Anthropic's published pricing.
// Bump PRICE_TABLE_VERSION when a rate changes; rows written before the bump
// keep their own cost.

export const PRICE_TABLE_VERSION = "2026-06-24";

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-sonnet-5": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
};

export const AGENT_MODEL = "claude-opus-5";

/**
 * Cost of one call in cents, to four decimal places — matching
 * `llm_calls.cost_cents numeric(12,4)`.
 *
 * Returns `null` for a model the table does not know, rather than throwing:
 * an unpriced model is an accounting gap, and failing the user's question
 * over one would be a worse trade. The null is visible in the column, and the
 * caller logs it.
 */
export function costCents(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  if (input < 0 || output < 0) throw new Error("token counts cannot be negative");

  const usd =
    (input / 1_000_000) * price.inputPerMTokUsd + (output / 1_000_000) * price.outputPerMTokUsd;
  return Math.round(usd * 100 * 10_000) / 10_000;
}
