// ADR 0010: the free-provider failover chain.
//
// A failover chain, not a load balancer. The deployment names an ordered
// preference list (`LLM_CHAIN=groq,nvidia`), each entry is resolved through
// the same spec table as the single-provider path, and a step that gets a
// 429, a 5xx or a timeout from one entry is retried on the next. Quality
// differs between free models, so the order is deterministic and the
// fallback is visible: every `llm_calls` row records who actually answered
// and which provider the chain preferred, the API response says so, and a
// cooldown map (process-local, resets on cold start) keeps a provider that
// said "come back in N" out of the running until N has passed.
//
// Spec 0013 adds the streaming step: the same per-step failover, but the
// failover window closes at the first token. After one provider has started
// answering, the stream is committed — switching mid-answer would mix two
// models' text into one response.
//
// Explicitly out of scope, per the decision record: rotating several API
// keys of the *same* provider to defeat its own free-tier limit. One key per
// service only.

import type Anthropic from "@anthropic-ai/sdk";
import {
  configured,
  clientFor,
  resolveProvider,
  PROVIDERS,
  type ProviderSpec,
  type ResolvedProvider,
} from "./index";
import {
  ModelError,
  RequestAbortedError,
  type ModelClient,
  type ModelRequestOptions,
  type ModelStream,
} from "./types";

/** The env var naming the ordered chain. `LLM_PROVIDER` pins one provider; this names several, in order. */
const CHAIN_ENV = "LLM_CHAIN";

/**
 * Parses and validates `LLM_CHAIN`. A name the spec table does not know, or
 * a provider listed twice, is a configuration mistake — silently dropping an
 * entry would quietly shorten the chain and hide the degradation this
 * feature exists to make visible, so it fails loudly instead.
 */
export function parseChain(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new ModelError(`LLM_CHAIN is set but names no providers (got "${raw}")`);
  }
  const known = new Set(PROVIDERS.map((provider) => provider.name));
  const seen = new Set<string>();
  for (const name of names) {
    if (!known.has(name)) {
      throw new ModelError(
        `LLM_CHAIN names "${name}", which is not a known provider — known providers are ${PROVIDERS.map((p) => p.name).join(", ")}`,
      );
    }
    if (seen.has(name)) {
      throw new ModelError(`LLM_CHAIN lists "${name}" twice — one key per provider, per ADR 0010`);
    }
    seen.add(name);
  }
  return names;
}

/**
 * The chain this deployment will use, resolved through the spec table.
 *
 * With `LLM_CHAIN` set: every named provider must be fully configured — a
 * chain entry whose key is missing is an error, not a silent shortening,
 * exactly like `LLM_PROVIDER` naming an unconfigured provider today.
 *
 * Without it: the pre-0010 single-provider resolution (one-element chain),
 * so deployments and the eval runner behave exactly as before.
 *
 * Returns null only when nothing at all is configured (the route's 503).
 */
export function resolveChain(extra?: ProviderSpec[]): ResolvedProvider[] | null {
  const raw = process.env[CHAIN_ENV];
  const chain: ResolvedProvider[] = [];
  if (raw === undefined || raw.trim() === "") {
    const single = resolveProvider();
    if (single) chain.push(single);
  } else {
    const names = parseChain(raw);
    for (const name of names) {
      const spec = PROVIDERS.find((provider) => provider.name === name);
      // parseChain already rejected unknown names; this keeps the type honest.
      if (!spec) throw new ModelError(`LLM_CHAIN names "${name}" but no such spec exists`);
      const entry = configured(spec);
      if (!entry) {
        throw new ModelError(
          `LLM_CHAIN names "${name}" but ${spec.keyVar}${
            spec.baseUrl ? "" : " and LLM_BASE_URL"
          } are not set`,
        );
      }
      chain.push(entry);
    }
  }

  // Runtime providers from copilot_settings (D-53) join the chain after the
  // environment-configured ones: an operator-added provider is a fallback,
  // never a replacement for the deployment's own preference order. A runtime
  // provider whose key env is unset is skipped silently — it was added in the
  // UI, so "the key is not set" is a settings problem, not a chain problem.
  for (const spec of extra ?? []) {
    const entry = configured(spec);
    if (entry) chain.push(entry);
  }
  return chain.length > 0 ? chain : null;
}

export interface ChainLink {
  name: string;
  model: string;
  client: ModelClient;
}

/** One attempt at one step: what was tried, and what came back. */
export interface ChainAttempt {
  provider: string;
  model: string;
  outcome: "answered" | "error" | "skipped";
  status?: number;
  message?: string;
  retryAfterMs?: number;
}

interface ChainStepResult {
  message: Anthropic.Message;
  /** The provider that actually answered — stamped onto the llm_calls row. */
  provider: string;
  /** The model that actually answered. */
  model: string;
  attempts: ChainAttempt[];
}

/** The streaming twin of ChainStepResult (spec 0013). */
interface ChainStreamResult {
  stream: ModelStream;
  /** The provider that actually answered — stamped onto the llm_calls row. */
  provider: string;
  /** The model that actually answered. */
  model: string;
  attempts: ChainAttempt[];
}

/**
 * The per-step failover view the loop drives. `createMessage` tries the
 * chain in order and resolves with whoever answered; it throws
 * `ChainExhaustedError` (a 429 that names the chain) only when nobody could.
 */
export interface ModelChain {
  /** Provider names in preference order; the head is the preferred one. */
  readonly names: string[];
  readonly preferredProvider: string;
  readonly preferredModel: string;
  createMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ModelRequestOptions,
  ): Promise<ChainStepResult>;
  /**
   * The streaming step (spec 0013): the same per-step failover, but the
   * failover window closes at the first token. After one provider has
   * started answering, the stream is committed — switching mid-answer would
   * mix two models' text into one response.
   */
  createMessageStream(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ModelRequestOptions,
  ): Promise<ChainStreamResult>;
}

/**
 * Every provider tried and none answered. Always a 429, by ADR 0010's
 * requirement that the chain's failure is one clear rate-limit-shaped answer
 * the client can tell apart from the budget gate's 429 (which is refused
 * before any model call and carries `retry_after`/`resets_at`).
 */
export class ChainExhaustedError extends ModelError {
  readonly attempts: ChainAttempt[];
  constructor(message: string, attempts: ChainAttempt[], retryAfterMs?: number) {
    super(message, 429, retryAfterMs);
    this.name = "ChainExhaustedError";
    this.attempts = attempts;
  }
}

interface ChainOptions {
  now?: () => number;
  /**
   * The cooldown store. Defaults to the process-wide map, which is the point
   * of ADR 0010: the map is process-local, survives across requests, and
   * resets on cold start. Tests inject their own map so one test's 429
   * cannot leak into the next.
   */
  cooldown?: Map<string, number>;
}

// The one state object ADR 0010 admits: process-local, deliberately not a
// shared store, and gone on cold start — so the next request re-tries the
// preferred provider.
const processCooldown = new Map<string, number>();

function statusOf(error: unknown): number | undefined {
  if (error instanceof ModelError) return error.status;
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function looksLikeTimeout(error: unknown): boolean {
  // The Anthropic SDK rejects timeouts as APIConnectionTimeoutError with no
  // status; treat a name/message that says so as a timeout.
  return (
    error instanceof Error &&
    /timeout|timed out|api connection/i.test(`${error.name} ${error.message}`)
  );
}

function exhaustedMessage(attempts: ChainAttempt[], names: string[], saw429: boolean): string {
  const lastError = [...attempts].reverse().find((a) => a.outcome === "error");
  const tail = lastError ? ` — last error from ${lastError.provider}: ${lastError.message}` : "";
  return saw429
    ? `every provider in the failover chain (${names.join(", ")}) is rate-limited or unreachable right now${tail}`
    : `every provider in the failover chain (${names.join(", ")}) failed${tail}`;
}

/** The text of a message, for the buffered fallback's single delta. */
function textOfMessage(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * One link's stream. A client with a streaming transport streams; one
 * without (the Anthropic SDK wrapper predates spec 0013) answers with one
 * buffered non-streaming call — the chain still picks it, the deltas just
 * arrive whole.
 */
async function linkStream(
  link: ChainLink,
  params: Anthropic.MessageCreateParamsNonStreaming,
  callOptions: ModelRequestOptions,
): Promise<ModelStream> {
  const merged = { ...params, model: link.model };
  if (link.client.streamMessage) return link.client.streamMessage(merged, callOptions);
  const message = await link.client.createMessage(merged, callOptions);
  const text = textOfMessage(message);
  return {
    deltas: (async function* () {
      if (text.length > 0) yield text;
    })(),
    message: Promise.resolve(message),
  };
}

/** Hands the already-awaited first delta to the consumer, then the rest. */
async function* prependFirst(first: string, rest: AsyncIterator<string>): AsyncGenerator<string> {
  yield first;
  for (;;) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

async function* emptyDeltas(): AsyncGenerator<string> {}

/**
 * Builds the chain runner. `links` are already-wrapped clients, so tests can
 * stub them; production wires `resolveChain()` through `clientFor()`.
 *
 * Every runner built without an explicit cooldown shares the process-wide
 * map, which is the point: a 429-with-a-wait from one request keeps that
 * provider out of the next — and a cold start drops the map, so the next
 * request re-tries the preferred provider (ADR 0010).
 */
export function createChain(links: ChainLink[], options: ChainOptions = {}): ModelChain {
  const now = options.now ?? Date.now;
  const cooldownUntil = options.cooldown ?? processCooldown;

  return {
    names: links.map((link) => link.name),
    preferredProvider: links[0].name,
    preferredModel: links[0].model,

    async createMessage(params, callOptions) {
      const attempts: ChainAttempt[] = [];
      let saw429 = false;
      let minCooldown: number | undefined;

      for (const link of links) {
        const until = cooldownUntil.get(link.name);
        if (until !== undefined) {
          if (until > now()) {
            attempts.push({
              provider: link.name,
              model: link.model,
              outcome: "skipped",
              message: `in cooldown until ${new Date(until).toISOString()}`,
            });
            continue;
          }
          cooldownUntil.delete(link.name); // expired: try it again
        }

        try {
          // Each client answers under its own model name, whatever the loop
          // passed — the chain is the only thing that knows which model goes
          // with which provider.
          const message = await link.client.createMessage(
            { ...params, model: link.model },
            callOptions,
          );
          attempts.push({ provider: link.name, model: link.model, outcome: "answered" });
          return { message, provider: link.name, model: link.model, attempts };
        } catch (error) {
          const status = statusOf(error);
          const retryAfterMs = error instanceof ModelError ? error.retryAfterMs : undefined;
          const timedOut =
            error instanceof ModelError ? error.timedOut === true : looksLikeTimeout(error);

          // A 429 that says when to come back puts the provider into
          // cooldown for exactly that window (ADR 0010).
          if (status === 429 && retryAfterMs !== undefined) {
            const until = now() + retryAfterMs;
            cooldownUntil.set(link.name, until);
            minCooldown = minCooldown === undefined ? until : Math.min(minCooldown, until);
          }
          if (status === 429) saw429 = true;

          attempts.push({
            provider: link.name,
            model: link.model,
            outcome: "error",
            status,
            message: error instanceof Error ? error.message : String(error),
            retryAfterMs,
          });

          const failover =
            status === 429 || (typeof status === "number" && status >= 500) || timedOut;
          if (!failover) throw error; // 4xx other than 429: a config/request bug, not provider trouble
        }
      }

      const names = links.map((link) => link.name);
      const retryAfterMs =
        minCooldown === undefined ? undefined : Math.max(1, minCooldown - now());
      throw new ChainExhaustedError(
        exhaustedMessage(attempts, names, saw429),
        attempts,
        retryAfterMs,
      );
    },

    async createMessageStream(params, callOptions) {
      const attempts: ChainAttempt[] = [];
      let saw429 = false;
      let minCooldown: number | undefined;

      for (const link of links) {
        const until = cooldownUntil.get(link.name);
        if (until !== undefined) {
          if (until > now()) {
            attempts.push({
              provider: link.name,
              model: link.model,
              outcome: "skipped",
              message: `in cooldown until ${new Date(until).toISOString()}`,
            });
            continue;
          }
          cooldownUntil.delete(link.name); // expired: try it again
        }

        try {
          const stream = await linkStream(link, params, callOptions);
          // The failover window closes at the first token (spec 0013): a
          // provider that has started answering is committed, because
          // switching mid-answer would mix two models' text into one
          // response. So the first delta is awaited here, inside the try —
          // a 429/5xx/timeout before it is provider trouble, and the next
          // link gets the request.
          const iterator = stream.deltas[Symbol.asyncIterator]();
          const first = await iterator.next();
          attempts.push({ provider: link.name, model: link.model, outcome: "answered" });
          if (first.done) {
            return {
              provider: link.name,
              model: link.model,
              attempts,
              stream: { deltas: emptyDeltas(), message: stream.message },
            };
          }
          return {
            provider: link.name,
            model: link.model,
            attempts,
            stream: { deltas: prependFirst(first.value, iterator), message: stream.message },
          };
        } catch (error) {
          // Same classification as createMessage — except a client abort is
          // never provider trouble: the user walked away, so the next link
          // must not get the request.
          const status = statusOf(error);
          const retryAfterMs = error instanceof ModelError ? error.retryAfterMs : undefined;
          const timedOut =
            error instanceof ModelError ? error.timedOut === true : looksLikeTimeout(error);
          if (error instanceof RequestAbortedError) throw error;

          if (status === 429 && retryAfterMs !== undefined) {
            const until = now() + retryAfterMs;
            cooldownUntil.set(link.name, until);
            minCooldown = minCooldown === undefined ? until : Math.min(minCooldown, until);
          }
          if (status === 429) saw429 = true;

          attempts.push({
            provider: link.name,
            model: link.model,
            outcome: "error",
            status,
            message: error instanceof Error ? error.message : String(error),
            retryAfterMs,
          });

          const failover =
            status === 429 || (typeof status === "number" && status >= 500) || timedOut;
          if (!failover) throw error; // 4xx other than 429: a config/request bug, not provider trouble
        }
      }

      const names = links.map((link) => link.name);
      const retryAfterMs =
        minCooldown === undefined ? undefined : Math.max(1, minCooldown - now());
      throw new ChainExhaustedError(
        exhaustedMessage(attempts, names, saw429),
        attempts,
        retryAfterMs,
      );
    },
  };
}

/**
 * The deployment's chain, or null when no provider is configured at all
 * (the route's 503). Throws ModelError on a malformed or incompletely
 * configured `LLM_CHAIN` — loud, because a silently shortened chain is the
 * exact failure mode ADR 0010 exists to prevent.
 *
 * A fresh runner per call, but sharing the process-wide cooldown map: the
 * clients are stateless and cheap to rebuild, and the cooldown is the one
 * piece of state that has to survive across requests (ADR 0010).
 */
export function createModelChain(extra?: ProviderSpec[]): ModelChain | null {
  const resolved = resolveChain(extra);
  if (resolved === null || resolved.length === 0) return null;
  return createChain(
    resolved.map((entry) => ({
      name: entry.spec.name,
      model: entry.model,
      client: clientFor(entry),
    })),
  );
}


