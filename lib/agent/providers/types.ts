import type Anthropic from "@anthropic-ai/sdk";

// The slice of a model API this agent actually uses.
//
// It is written in Anthropic's message shape rather than a neutral one for a
// deliberate reason: the loop was built against that shape, it is the richer
// of the two (content blocks carry tool calls and text in one ordered list),
// and every OpenAI-compatible response can be translated into it without
// losing anything. Translating the other way would flatten the block list.
//
// So the Anthropic SDK satisfies this interface as it is, and every other
// provider arrives through an adapter that speaks it.

export interface ModelRequestOptions {
  timeoutMs: number;
}

export interface ModelClient {
  /** Which model the turn actually ran on — stamped onto every `llm_calls` row. */
  readonly model: string;
  /** Names the provider in logs and in the route's "not configured" message. */
  readonly provider: string;
  createMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ModelRequestOptions,
  ): Promise<Anthropic.Message>;
}

export class ModelError extends Error {
  readonly status?: number;
  /**
   * How long the provider asked us to wait, from `Retry-After`. Free tiers
   * rate-limit by tokens per minute and say exactly when to come back — a
   * batch job like the eval runner should honour that; a user waiting on a
   * page should not, which is why this is carried rather than slept on here.
   */
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
