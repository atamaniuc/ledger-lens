// The price table, versioned in the repository.
//
// ADR 0009: cost is computed at write time and stored on the row, so a
// historical `llm_calls` row keeps the price actually paid. Deriving cost at
// read time from current pricing would silently rewrite last month's numbers
// the next time Anthropic changes a rate — which, in a project whose whole
// argument is that the numbers can be trusted, is the wrong failure.
//
// Rates are US dollars per million tokens, from the providers' published
// pricing. A PRICE_TABLE_VERSION constant used to sit here with a comment
// telling the reader to bump it when a rate changed — nothing read it and no
// row stored it, so the contract was unenforceable (D-41). What makes a
// historical row trustworthy is that its cost was computed at write time and
// stored, and `git log` on this file is the version.

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-sonnet-5": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },

  // Free tiers, priced at zero because that is what they cost — not because
  // the model is unknown. `costCents` returns null for a model this table has
  // never heard of, and the two cases have to stay distinguishable: a null in
  // `llm_calls.cost_cents` is an accounting gap to chase, a 0 is a fact.
  // Rate limits, not money, are what bounds these.
  //
  // This is the list of models the project has actually been run on, not a
  // registry of everything a provider offers. Pointing `GROQ_MODEL` at
  // something else is fine and costs a null in the column, which is the
  // honest answer to "what did that turn cost".
  "openai/gpt-oss-20b": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "openai/gpt-oss-120b": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "moonshotai/kimi-k2-instruct": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "qwen/qwen3.6-27b": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "meta/llama-3.3-70b-instruct": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
};

// There used to be an AGENT_MODEL constant here, naming "the default model".
// It was a second source of truth — `providers/index.ts` already declares a
// `defaultModel` per provider, and since decision 0010 a turn picks its model
// from an ordered chain, so a single default is not even a coherent idea any
// more. Only a test read it (D-41). What a turn actually ran on is recorded on
// its own `llm_calls` row, which is the only answer that cannot drift.

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
