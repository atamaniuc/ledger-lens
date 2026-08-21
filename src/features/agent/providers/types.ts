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
  /**
   * The caller's abort signal (spec 0013). When it fires, the provider call
   * stops: a client that disconnects must not keep paying for a turn. The
   * OpenAI-compatible adapter combines it with its own timeout; the loop also
   * races the whole step against it, so a provider that cannot take a signal
   * (the Anthropic SDK wrapper predates this) still stops within one step.
   */
  signal?: AbortSignal;
}

/** One streaming model call (spec 0013): text deltas as they arrive, then the full message. */
export interface ModelStream {
  /** The answer's text, in arrival order. The loop forwards each delta as a token event. */
  deltas: AsyncIterable<string>;
  /**
   * Resolves with the fully translated message once every delta has been
   * consumed — a stream is driven by its consumer, so this is a promise the
   * consumer's completion settles, not a value fetched eagerly.
   */
  message: Promise<Anthropic.Message>;
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
  /**
   * The streaming transport (spec 0013). Optional because the eval runner's
   * stubs and the pre-0013 single-provider wrappers implement only
   * createMessage; the loop falls back to one buffered non-streaming call
   * when it is absent, so a deployment on a client without streaming still
   * answers — it just cannot show token deltas while it does.
   */
  streamMessage?(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ModelRequestOptions,
  ): Promise<ModelStream>;
}

/**
 * The caller's request was aborted — by the client disconnecting, not by the
 * provider or a timeout. Carried as its own error so the loop can tell "the
 * user walked away" from "the provider is slow", which must end the turn as
 * `cancelled` rather than as an error.
 */
export class RequestAbortedError extends Error {
  constructor(message = "request aborted by the client") {
    super(message);
    this.name = "RequestAbortedError";
  }
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
  /**
   * True when the provider was reached but never answered inside the call's
   * timeout. The failover chain (ADR 0010) treats a timeout like a 5xx: the
   * provider cannot answer right now, so the next one gets the request.
   */
  readonly timedOut?: boolean;

  constructor(message: string, status?: number, retryAfterMs?: number, timedOut = false) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.timedOut = timedOut;
  }
}
