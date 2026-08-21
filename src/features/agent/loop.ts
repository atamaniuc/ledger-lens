// The agent loop: bounded three ways, audited every step.
//
// ADR 0009. At most 6 tool-call steps, a 30-second wall-clock budget, and a
// token ceiling. Each bound ends the turn with a *stated reason* rather than
// a truncated answer that reads like a complete one, and the bounds are
// enforced here rather than inherited from the deploy platform's function
// timeout — so they hold identically on a laptop and on Vercel.
//
// Spec 0013 adds two more ways a turn ends without forking the decision
// logic:
//
//   * A streaming transport. The same step calls the model's
//     `streamMessage` instead of `createMessage` when the route asked for
//     SSE (one loop, two transports), forwards text deltas as token events,
//     and emits a step event when a tool starts and a summary when it
//     returns. Every bound, citation check, tool gate and audit write is
//     exactly the same on both transports.
//   * Cancellation. The request's AbortSignal is threaded in; the loop
//     checks it at every step boundary and races it against every provider
//     call, so a client that disconnects stops the turn within one step and
//     lands in the audit as `cancelled` — never as an answer.
//   * Bounded memory. A follow-up sees the prior question and answer from
//     `conversation_turns` (re-fetched, never replayed from the client),
//     trimmed to a token budget that drops the oldest turns first.
//
// The model client is injected so the tests can drive every termination path
// without a network call or an API key.

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";
import { logAgentAction, logLlmCall, type StepOutcome } from "./audit";
import { verifyCitations, type Citation } from "./citations";
import type { ModelChain, ChainAttempt, ModelClient } from "./providers";
import { ChainExhaustedError } from "./providers";
import {
  ModelError,
  RequestAbortedError,
  type ModelRequestOptions,
  type ModelStream,
} from "./providers/types";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { runTool, toolDefinitions, type ToolContext } from "./tools";
import { looksLikeEmbeddedInstruction, withDisclosure } from "./injection";
import { trace, type Span } from "@/platform/obs";

export const MAX_STEPS = 6;
export const TURN_BUDGET_MS = 30_000;
/** Cumulative input + output tokens for one turn, across every step. */
export const TOKEN_CEILING = 120_000;
/**
 * Per-response cap. Deliberately small: answers are two or three sentences
 * (see the prompt), and a large cap inside a 30-second turn budget buys
 * nothing but a longer wait before the budget kills it.
 */
export const MAX_RESPONSE_TOKENS = 4_096;

/**
 * Consecutive steps that return no data before the turn abstains.
 *
 * Not 1. A compound question — "which invoices are overdue, and what is our
 * late-fee policy?" — can begin with a search for the half the corpus does
 * not contain, and abstaining on that first empty result throws away the half
 * `list_invoices` could have answered. One empty search is a clause that
 * found nothing; two consecutive empty steps is a question this data cannot
 * answer.
 */
export const EMPTY_STEPS_BEFORE_ABSTAINING = 2;

/**
 * What the agent says when retrieval came back empty. US-06 asks the model to
 * admit when it does not know; this is the mechanism behind that, because a
 * prompt asking a model not to hallucinate is a request and not calling the
 * model is a guarantee.
 */
export const ABSTENTION_ANSWER =
  "I don't have data on that. Nothing in this organization's invoices or documents matches the question.";

/**
 * D-25 — the instruction for the one citation repair a turn may attempt.
 *
 * The model is asked to restate its answer with the citations it omitted,
 * naming exactly the ids that were actually retrieved this turn. Naming them
 * is what keeps the repair deterministic: the model does not have to recall
 * which ids its tool results carried, and it cannot invent an id the evidence
 * does not contain and still be believed. "Available" means available *to
 * cite* — which is also the gate the loop applies before asking (no ids, no
 * repair; asking would be inviting fabrication).
 */
export function citationRepairInstruction(
  chunkIds: readonly number[],
  invoiceExternalIds: readonly string[],
): string {
  const available: string[] = [];
  if (chunkIds.length > 0) available.push(`chunk ids: ${chunkIds.join(", ")}`);
  if (invoiceExternalIds.length > 0)
    available.push(`invoice ids: ${invoiceExternalIds.join(", ")}`);

  return (
    "Your previous answer contained no citations, so it cannot be verified. " +
    "Restate the same answer so every factual claim carries a citation — " +
    "[chunk:<id>] or [invoice:<external_id>] — taken from this turn's tool results. " +
    (available.length > 0 ? `Available to cite: ${available.join("; ")}. ` : "") +
    "If a claim cannot be cited, omit it or say it was not found. " +
    "Do not invent citations: only ids from this turn's tool results are acceptable."
  );
}

/**
 * How much prior conversation a follow-up may carry (spec 0013, AC-03).
 *
 * Tokens, not turns: a turn that cost 1,200 tokens to answer is not the same
 * memory as one that cost 40, and the budget has to be a number the loop can
 * enforce rather than a count it hopes is small enough.
 */
export const HISTORY_TOKEN_BUDGET = 2_000;

/** One prior turn, as stored in conversation_turns and handed to the loop. */
export interface ConversationTurn {
  question: string;
  answer: string;
}

/**
 * A rough per-turn token estimate: four characters per token, the standard
 * rule of thumb. The budget's job is to keep the input context bounded, not
 * to bill anyone, so an estimate is honest where a precise count would be
 * pretending.
 */
export function estimateTurnTokens(turn: ConversationTurn): number {
  return Math.ceil((turn.question.length + turn.answer.length) / 4);
}

/**
 * The bounded history a follow-up sees (AC-03): the newest turns that fit the
 * budget, oldest dropped first. The newest turn is always kept — a follow-up
 * must at least see the turn it follows — and after that the older turns come
 * in while they fit.
 */
export function assembleHistory(
  turns: readonly ConversationTurn[],
  budgetTokens = HISTORY_TOKEN_BUDGET,
): ConversationTurn[] {
  const kept: ConversationTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const cost = estimateTurnTokens(turn);
    if (kept.length > 0 && total + cost > budgetTokens) break;
    kept.unshift(turn);
    total += cost;
  }
  return kept;
}

/**
 * One progressive event the route forwards to a streaming client (AC-01).
 * Emitted by the loop at the moment it happens, so a reader can tell thinking
 * from hanging. The final result is not an event here — the route sends it
 * last, with the correlation_id attached.
 */
export type AgentStepEvent =
  | { type: "step"; stepNo: number; tool: string; args: unknown }
  | { type: "tool_result"; stepNo: number; tool: string; summary: string }
  | { type: "tokens"; text: string };

export interface AgentTurnRequest {
  question: string;
  orgId: string;
  correlationId: string;
  supabase: SupabaseClient<Database>;
  /**
   * A single provider, when the deployment has no chain — the eval runner
   * pins one provider per run this way (ADR 0010 keeps that path). Exactly
   * one of `model` and `chain` must be set.
   */
  model?: ModelClient;
  /** The ADR 0010 failover chain: per-step provider selection. */
  chain?: ModelChain;
  now?: () => number;
  limits?: Partial<{
    maxSteps: number;
    budgetMs: number;
    tokenCeiling: number;
  }>;
  /**
   * The turn's span, when the caller opened one (spec 0011). Every span below
   * hangs off it, so one trace covers the request, each model call and each
   * tool call, joined to the logs by `correlationId` being the trace id.
   */
  parentSpan?: Span;
  /**
   * The request's abort signal (spec 0013). When it fires, the loop stops
   * within one step, makes no further provider call, and records the turn as
   * `cancelled`. Absent for the eval runner and the unit tests, which is
   * what keeps the non-streaming contract byte-for-byte.
   */
  signal?: AbortSignal;
  /**
   * The streaming transport (AC-01). True only when the route negotiated
   * `Accept: text/event-stream`; the decision logic — bounds, tools,
   * citations, audit — is the same code either way.
   */
  stream?: boolean;
  /** Forwards step events as they happen. Absent on the JSON path. */
  emit?: (event: AgentStepEvent) => void;
  /**
   * Prior turns in this conversation (AC-03), re-fetched by the route — never
   * replayed from the client (ADR 0009). Bounded here, by
   * `assembleHistory`, so the enforcement and the test of it share one
   * function.
   */
  history?: readonly ConversationTurn[];
  /** Overrides HISTORY_TOKEN_BUDGET; the unit tests use it for the boundary. */
  historyTokenBudget?: number;
}

export interface AgentTurnResult {
  answer: string;
  outcome: StepOutcome;
  /** Why the turn ended, in words, when it ended on a bound. */
  terminationReason: string | null;
  steps: number;
  toolsUsed: string[];
  retrievedChunkIds: number[];
  citedInvoiceIds: string[];
  /** Every id the answer cited, each marked verified against what was retrieved. */
  citations: Citation[];
  /**
   * False when the answer cited an id that was never in a tool result this
   * turn, **or** when it cited nothing at all. The answer is still returned —
   * the flag is the signal, and deleting the citation would hide it.
   */
  verified: boolean;
  /** True when an answer was produced with no citation of any kind. */
  uncited: boolean;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * The provider that answered the turn's final model call. Null when a
   * bound ended the turn before any call answered. Optional so a fixture
   * that predates ADR 0010 still typechecks; the loop always sets it.
   */
  provider?: string | null;
  /** The model that answered the turn's final model call. Null when none did. */
  model?: string | null;
  /**
   * True when any step of the turn was answered by a non-preferred provider
   * (ADR 0010: silent degradation to a weaker model is the failure this
   * feature exists to make visible).
   */
  fallback?: boolean;
  /** Every chain attempt across the turn, in order — the visible trace. */
  chainAttempts?: ChainAttempt[];
}

/** Outcome for a turn the client aborted (spec 0013): audited, never an answer. */
const CANCELLED: StepOutcome = "cancelled";

interface RetrievedEvidence {
  chunkIds: number[];
  invoiceExternalIds: string[];
  /** Row ids of the same invoices: a citation naming one of these verifies too. */
  invoiceRowIds: string[];
  /** At least one tool returned rows this turn. */
  anyData: boolean;
  /** At least one search came back with nothing. */
  searchedAndFoundNothing: boolean;
  /**
   * Retrieved text contained something shaped like an instruction to the
   * assistant. Detected on the retrieval path rather than asked of the model:
   * a measured run had every injection case score zero because the answer
   * never mentioned it (see ./injection.ts).
   */
  injectionSuspected: boolean;
  /** The chunks that tripped the detector, for the audit trail. */
  suspiciousChunkIds: number[];
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function collectEvidence(toolName: string, result: unknown, into: RetrievedEvidence): void {
  if (!result || typeof result !== "object") return;

  if (toolName === "search_documents") {
    const chunks =
      (result as {
        chunks?: {
          chunk_id: number;
          invoice_id?: string | null;
          invoice_external_id: string | null;
          content?: string;
        }[];
      }).chunks ?? [];
    for (const chunk of chunks) {
      into.chunkIds.push(chunk.chunk_id);
      // An invoice-derived chunk reads "Invoice inv_00007 for customer …", so
      // the model can cite the invoice from a search alone. Recording only the
      // chunk id here made a correct citation come back unverified.
      if (chunk.invoice_external_id !== null) {
        into.invoiceExternalIds.push(chunk.invoice_external_id);
      }
      if (chunk.invoice_id) into.invoiceRowIds.push(chunk.invoice_id);
      if (typeof chunk.content === "string" && looksLikeEmbeddedInstruction(chunk.content)) {
        into.injectionSuspected = true;
        into.suspiciousChunkIds.push(chunk.chunk_id);
      }
    }
    if (chunks.length > 0) into.anyData = true;
    else into.searchedAndFoundNothing = true;
  }
  if (toolName === "list_invoices") {
    const invoices =
      (result as { invoices?: { external_id: string; invoice_id?: string }[] }).invoices ?? [];
    for (const invoice of invoices) {
      into.invoiceExternalIds.push(invoice.external_id);
      if (invoice.invoice_id) into.invoiceRowIds.push(invoice.invoice_id);
    }
    if (invoices.length > 0) into.anyData = true;
  }
  if (toolName === "get_revenue_summary") {
    const summary = result as { invoice_count?: number; evidence_invoice_ids?: string[] };
    const count = summary.invoice_count ?? 0;
    if (count > 0) into.anyData = true;
    // A figure the answer can attribute: without these ids a compliant answer
    // to "what did we invoice in July" was unverifiable by construction (D-25).
    for (const id of summary.evidence_invoice_ids ?? []) into.invoiceExternalIds.push(id);
  }
  if (toolName === "draft_customer_email") {
    const invoice = (result as { invoice?: { external_id: string } }).invoice;
    if (invoice) {
      into.invoiceExternalIds.push(invoice.external_id);
      into.anyData = true;
    }
  }
}

/** One line for the panel: what a tool returned, in the fewest words. */
function summarizeToolResult(toolName: string, result: unknown): string {
  if (!result || typeof result !== "object") return "no rows";
  if (toolName === "search_documents") {
    const count = (result as { chunks?: unknown[] }).chunks?.length ?? 0;
    return count === 1 ? "1 chunk" : `${count} chunks`;
  }
  if (toolName === "list_invoices") {
    const count = (result as { invoices?: unknown[] }).invoices?.length ?? 0;
    return count === 1 ? "1 invoice" : `${count} invoices`;
  }
  if (toolName === "get_revenue_summary") {
    const count = (result as { invoice_count?: number }).invoice_count ?? 0;
    return `${count} invoices`;
  }
  if (toolName === "draft_customer_email") {
    const invoice = (result as { invoice?: { external_id?: string } }).invoice;
    return invoice ? `draft for ${invoice.external_id ?? "invoice"}` : "no draft";
  }
  return "done";
}

/**
 * The abort signal as a rejection the loop can race against. Returns null
 * when there is no signal, so the non-cancellable paths (the eval runner,
 * the unit tests) pay nothing.
 */
function abortPromise(signal: AbortSignal | undefined): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new RequestAbortedError()), { once: true });
  });
}

/**
 * Races one provider step against the request's abort signal, so a client
 * that disconnects stops the turn even when the provider cannot take a
 * signal itself (the Anthropic SDK wrapper predates spec 0013). The loser's
 * settlement is observed so it can never become an unhandled rejection.
 */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const aborter = abortPromise(signal);
  if (!aborter) return promise;
  try {
    return await Promise.race([promise, aborter]);
  } finally {
    promise.catch(() => {});
  }
}

/** A client without a streaming transport answers in one buffered chunk. */
async function bufferedStream(
  client: ModelClient,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: ModelRequestOptions,
): Promise<ModelStream> {
  const message = await client.createMessage(params, options);
  const text = textOf(message);
  return {
    deltas: (async function* () {
      if (text.length > 0) yield text;
    })(),
    message: Promise.resolve(message),
  };
}

interface StreamedStep {
  message: Anthropic.Message;
  provider: string;
  model: string;
  attempts: ChainAttempt[];
}

/**
 * One streaming step (AC-01): pick the provider through the same chain as the
 * JSON path, consume the deltas — forwarding each as a token event — and
 * resolve with the fully translated message. A client abort mid-stream
 * surfaces as RequestAbortedError, which the loop records as `cancelled`.
 */
async function streamStep(
  request: AgentTurnRequest,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: ModelRequestOptions,
): Promise<StreamedStep> {
  let provider: string;
  let model: string;
  let attempts: ChainAttempt[];
  let stream: ModelStream;

  if (request.chain) {
    const step = await request.chain.createMessageStream(params, options);
    provider = step.provider;
    model = step.model;
    attempts = step.attempts;
    stream = step.stream;
  } else {
    const client = request.model!;
    provider = client.provider;
    model = client.model;
    attempts = [];
    stream = client.streamMessage
      ? await client.streamMessage(params, options)
      : await bufferedStream(client, params, options);
  }

  const iterator = stream.deltas[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    request.emit?.({ type: "tokens", text: next.value });
  }

  return { message: await stream.message, provider, model, attempts };
}

/**
 * Runs one turn. Returns an answer or a stated termination; never throws for
 * a bound being hit, and always leaves an `llm_calls` row per model call.
 */
export async function runAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  const now = request.now ?? Date.now;
  const maxSteps = request.limits?.maxSteps ?? MAX_STEPS;
  const budgetMs = request.limits?.budgetMs ?? TURN_BUDGET_MS;
  const tokenCeiling = request.limits?.tokenCeiling ?? TOKEN_CEILING;
  const signal = request.signal;

  if (!request.chain && !request.model) {
    throw new Error("runAgentTurn requires either a single model or a failover chain");
  }

  // Stamped onto every `llm_calls` row: the provider and model that actually
  // answered each step, and the chain head the deployment preferred at write
  // time (ADR 0010) — a historical row keeps both, rather than whichever the
  // code defaults to today.
  const preferredProvider = request.chain?.preferredProvider ?? request.model?.provider ?? "";
  const preferredModel = request.chain?.preferredModel ?? request.model?.model ?? "";
  const startedAt = now();
  const toolContext: ToolContext = {
    supabase: request.supabase,
    orgId: request.orgId,
    correlationId: request.correlationId,
  };

  // AC-03: a follow-up sees the prior question and answer, bounded by the
  // token budget here (oldest dropped first), and re-fetched by the route —
  // never replayed from the client (ADR 0009).
  const history = assembleHistory(request.history ?? [], request.historyTokenBudget);
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  messages.push({ role: "user", content: request.question });

  const evidence: RetrievedEvidence = {
    chunkIds: [],
    invoiceExternalIds: [],
    invoiceRowIds: [],
    anyData: false,
    searchedAndFoundNothing: false,
    injectionSuspected: false,
    suspiciousChunkIds: [],
  };
  const toolsUsed: string[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let stepNo = 0;
  let lastText = "";
  let emptySteps = 0;

  // ADR 0010 visibility: which provider/model answered the turn's last call,
  // whether any step fell back off the preferred provider, and every chain
  // attempt in order — carried in the result for the API response.
  let lastAnsweredProvider: string | null = null;
  let lastAnsweredModel: string | null = null;
  let fallbackSeen = false;
  const chainAttempts: ChainAttempt[] = [];

  const finish = async (
    outcome: StepOutcome,
    answer: string,
    terminationReason: string | null,
  ): Promise<AgentTurnResult> => {
    // A turn that ended on a bound gets its own `llm_calls` row: zero tokens,
    // because no call was made, and the outcome naming which bound stopped
    // it. Without it the table's last row would say `ok` about a turn that
    // was cut short, which is the exact confusion `outcome` exists to
    // prevent. `audit_log` gets the turn-level record either way.
    if (outcome !== "ok") {
      await logLlmCall(request.supabase, {
        orgId: request.orgId,
        correlationId: request.correlationId,
        stepNo,
        model: preferredModel,
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: now() - startedAt,
        toolName: null,
        toolArgs: null,
        // D-09: whatever the turn had retrieved by the time a bound ended it.
        // Never null — the column exists to make retrieval auditable, and an
        // empty array says "nothing retrieved" where null would say "not
        // recorded".
        retrievedChunkIds: [...new Set(evidence.chunkIds)],
        outcome,
        // No call was made, so nothing fell back: the bound row is stamped
        // with the preferred provider, which keeps it out of the fallback
        // rate (provider = preferred_provider).
        provider: preferredProvider,
        preferredProvider,
      });
    }

    await logAgentAction(request.supabase, {
      orgId: request.orgId,
      correlationId: request.correlationId,
      action: "turn_ended",
      entity: "agent_turn",
      entityId: request.correlationId,
      details: {
        outcome,
        termination_reason: terminationReason,
        steps: stepNo,
        tools_used: toolsUsed,
        retrieved_chunk_ids: [...new Set(evidence.chunkIds)],
        // Named in the audit trail, not only in the answer: a poisoned document
        // that reached a turn is a security event whether or not the reader
        // noticed the sentence.
        suspicious_chunk_ids: [...new Set(evidence.suspiciousChunkIds)],
      },
    });

    // Disclosure is a mechanism, not a request (see ./injection.ts). If the
    // retrieved text contained an instruction addressed to the assistant and
    // the answer does not already say so, the turn says it — the containment
    // was never in doubt, but the reader was not being told.
    const disclosed = withDisclosure(answer, evidence.injectionSuspected && outcome === "ok");

    const check = verifyCitations(disclosed, {
      chunkIds: evidence.chunkIds,
      invoiceExternalIds: evidence.invoiceExternalIds,
      invoiceRowIds: evidence.invoiceRowIds,
    });

    return {
      answer: disclosed,
      outcome,
      terminationReason,
      steps: stepNo,
      toolsUsed,
      retrievedChunkIds: [...new Set(evidence.chunkIds)],
      citedInvoiceIds: [...new Set(evidence.invoiceExternalIds)],
      citations: check.citations,
      // An answer that cites nothing is not verified either, and calling it
      // verified was the more dangerous of the two mistakes: a model that
      // wrote "The average open invoice is $2,778.40" with a tool name in
      // decorative brackets produced no citations at all, so there was
      // nothing to fail — and the panel showed no warning over a figure that
      // silently disagreed with the dashboard.
      //
      // An abstention is exempt, because "I don't have data on that" is a
      // statement about the absence of evidence and citing something for it
      // would be the contradiction.
      verified:
        !check.hasUnverified && !(outcome === "ok" && check.hasNoCitations),
      uncited: outcome === "ok" && check.hasNoCitations,
      usage: { inputTokens, outputTokens },
      provider: lastAnsweredProvider,
      model: lastAnsweredModel,
      fallback: fallbackSeen,
      chainAttempts: [...chainAttempts],
    };
  };

  for (;;) {
    // Cancellation is checked before the bounds: a client that walked away
    // must end the turn as `cancelled`, not as a timeout it never saw.
    if (signal?.aborted) {
      return await finish(
        CANCELLED,
        lastText || "The request was cancelled.",
        "cancelled by the client",
      );
    }
    // Bounds are checked before spending, not after: a step that cannot
    // finish inside the budget should not be started.
    if (stepNo >= maxSteps) {
      return await finish(
        "step_cap",
        lastText ||
          "I stopped after the maximum number of tool steps for one question. Ask a narrower question and I will try again.",
        `step cap of ${maxSteps} reached`,
      );
    }
    if (now() - startedAt >= budgetMs) {
      return await finish(
        "timeout",
        lastText || "I ran out of time on this question before I could finish.",
        `time budget of ${budgetMs}ms exhausted`,
      );
    }
    if (inputTokens + outputTokens >= tokenCeiling) {
      return await finish(
        "token_ceiling",
        lastText || "This question needed more context than one turn allows.",
        `token ceiling of ${tokenCeiling} reached`,
      );
    }

    const calledAt = now();
    // The turn budget is only a bound if the call inside it is bounded too.
    // Checking the clock at the top of the loop cannot stop a model call that
    // never returns, and the outcome would only be recorded on an iteration
    // that never happens — so the remaining budget is handed to the provider
    // as the request's own timeout.
    const callParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: preferredModel,
      max_tokens: MAX_RESPONSE_TOKENS,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions() as Anthropic.Tool[],
      messages,
    };
    const timeoutMs = Math.max(1_000, budgetMs - (calledAt - startedAt));
    // The caller's signal is handed to the provider too, so a disconnect
    // aborts the fetch itself rather than only the wait for it.
    const callOptions: ModelRequestOptions = { timeoutMs, signal };

    let response: Anthropic.Message;
    let answeringProvider: string;
    let answeringModel: string;
    let stepAttempts: ChainAttempt[];
    try {
      // One span per model call (spec 0011). The failover attempts inside the
      // chain are the interesting part of a slow turn, so the span covers the
      // whole selection, not just the request that eventually answered.
      const stepSpanOpts = {
        traceId: request.correlationId,
        parent: request.parentSpan,
        kind: "client" as const,
        attributes: { step_no: stepNo, provider: request.chain ? "chain" : request.model!.provider },
      };
      if (request.stream) {
        // Spec 0013's transport: the same step, the same bounds, the same
        // audit — only the wire differs. Deltas are forwarded as token
        // events from inside the step.
        const step = await trace(
          "agent.step",
          () => withAbort(streamStep(request, callParams, callOptions), signal),
          stepSpanOpts,
        );
        response = step.message;
        answeringProvider = step.provider;
        answeringModel = step.model;
        stepAttempts = step.attempts;
      } else if (request.chain) {
        // ADR 0010: try the chain in order — 429/5xx/timeout moves on to the
        // next provider, and the one that answered is the one recorded.
        const step = await trace(
          "agent.step",
          () => withAbort(request.chain!.createMessage(callParams, callOptions), signal),
          stepSpanOpts,
        );
        response = step.message;
        answeringProvider = step.provider;
        answeringModel = step.model;
        stepAttempts = step.attempts;
      } else {
        response = await trace(
          "agent.step",
          () => withAbort(request.model!.createMessage(callParams, callOptions), signal),
          stepSpanOpts,
        );
        answeringProvider = request.model!.provider;
        answeringModel = request.model!.model;
        stepAttempts = [];
      }
    } catch (error) {
      // The client walked away: the turn ends as `cancelled`, within one
      // step, with no further provider call. Not an error — the audit must
      // say cancelled, and the route must not surface a 500 to a socket that
      // is already closed.
      if (error instanceof RequestAbortedError || signal?.aborted) {
        return await finish(
          CANCELLED,
          lastText || "The request was cancelled.",
          "cancelled by the client",
        );
      }
      // Only the chain path throws here — and when every provider failed, the
      // step is audited (zero tokens, outcome error) so a chain outage shows
      // up in llm_calls rather than only in the API response, then rethrown
      // for the route to map to its distinguishable 429.
      if (error instanceof ChainExhaustedError && request.chain) {
        chainAttempts.push(...error.attempts);
        await logLlmCall(request.supabase, {
          orgId: request.orgId,
          correlationId: request.correlationId,
          stepNo,
          model: preferredModel,
          promptVersion: PROMPT_VERSION,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: now() - calledAt,
          // No tool ran; tool_args carries the chain's attempts so an outage
          // is queryable from llm_calls, not only visible in the API body.
          toolName: null,
          toolArgs: error.attempts,
          retrievedChunkIds: [...new Set(evidence.chunkIds)],
          outcome: "error",
          provider: preferredProvider,
          preferredProvider,
        });
      }
      throw error;
    }

    if (stepAttempts.length > 0) chainAttempts.push(...stepAttempts);
    if (answeringProvider !== preferredProvider) fallbackSeen = true;
    lastAnsweredProvider = answeringProvider;
    lastAnsweredModel = answeringModel;

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    lastText = textOf(response) || lastText;

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    await logLlmCall(request.supabase, {
      orgId: request.orgId,
      correlationId: request.correlationId,
      stepNo,
      model: answeringModel,
      promptVersion: PROMPT_VERSION,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs: now() - calledAt,
      toolName: toolUses[0]?.name ?? null,
      toolArgs: toolUses.length > 0 ? toolUses.map((use) => use.input) : null,
      // D-09: the chunk ids collected so far, deduplicated. The first row of
      // a turn carries what earlier steps retrieved; the final row carries
      // the complete context the answer was built from. Never null — an empty
      // array records "nothing retrieved yet" without losing the column's
      // meaning (see migration 20260821100000 and the retrieval-audit test).
      retrievedChunkIds: [...new Set(evidence.chunkIds)],
      outcome: "ok",
      // ADR 0010: who actually answered this step.
      provider: answeringProvider,
      preferredProvider,
    });

    if (toolUses.length === 0) {
      // The backstop for US-06. The model has stopped calling tools and is
      // answering; if nothing it called ever returned data, whatever it wrote
      // was written over an empty context and is discarded rather than
      // returned. The short-circuit below is what usually catches this — this
      // is what catches the case where the model reached for text first.
      if (evidence.searchedAndFoundNothing && !evidence.anyData) {
        return await finish("abstained", ABSTENTION_ANSWER, "retrieval returned nothing");
      }

      // D-25 — the citation repair. The eval measured the model's uncited
      // answers honestly (0.23 against a 0.95 bar), and the fix is not to
      // lower the bar but to give the turn one deterministic chance to meet
      // it: when the answer cites nothing at all and the turn retrieved ids
      // it could have cited, ask once for a revision that names the missing
      // citations, verify the revision with the same check, and keep the
      // original answer when the revision is no better — a repair that hides
      // a bad answer is worse than the bad answer.
      //
      // Three deliberate gates:
      //   * `anyData` — an answer over no retrieved data has nothing to cite,
      //     and abstentions have already returned above (never repaired).
      //   * citable ids — no chunk or invoice id came back, so there is no
      //     citation to name; asking would be inviting fabrication.
      //   * the bounds, checked here because they are spent *again*: the
      //     answer just produced may have consumed the last of the wall
      //     clock or the token ceiling, and the repair is one step like any
      //     other inside the step cap.
      if (
        evidence.anyData &&
        (evidence.chunkIds.length > 0 || evidence.invoiceExternalIds.length > 0)
      ) {
        const citationCheck = verifyCitations(lastText, {
          chunkIds: evidence.chunkIds,
          invoiceExternalIds: evidence.invoiceExternalIds,
          invoiceRowIds: evidence.invoiceRowIds,
        });

        if (citationCheck.hasNoCitations) {
          const originalText = lastText;
          const originalStepNo = stepNo;
          const repairStepNo = stepNo + 1;

          if (
            repairStepNo <= maxSteps &&
            now() - startedAt < budgetMs &&
            inputTokens + outputTokens < tokenCeiling
          ) {
            const repairCalledAt = now();
            const repairParams: Anthropic.MessageCreateParamsNonStreaming = {
              model: preferredModel,
              max_tokens: MAX_RESPONSE_TOKENS,
              system: SYSTEM_PROMPT,
              // No tools on purpose: the repair is a revision of the answer,
              // not another chance to call a tool — one text call, nothing
              // more, whatever the model asks for.
              messages: [
                ...messages,
                {
                  role: "user",
                  content: citationRepairInstruction(
                    evidence.chunkIds,
                    evidence.invoiceExternalIds,
                  ),
                },
              ],
            };
            const repairTimeoutMs = Math.max(1_000, budgetMs - (repairCalledAt - startedAt));
            const repairOptions: ModelRequestOptions = { timeoutMs: repairTimeoutMs, signal };

            try {
              const repairedStep = await trace(
                "agent.step",
                () => withAbort(streamStep(request, repairParams, repairOptions), signal),
                {
                  traceId: request.correlationId,
                  parent: request.parentSpan,
                  kind: "client" as const,
                  attributes: {
                    step_no: repairStepNo,
                    provider: request.chain ? "chain" : request.model!.provider,
                  },
                },
              );

              const repairedText = textOf(repairedStep.message);
              const repairedCheck = verifyCitations(repairedText, {
                chunkIds: evidence.chunkIds,
                invoiceExternalIds: evidence.invoiceExternalIds,
                invoiceRowIds: evidence.invoiceRowIds,
              });
              // "No better" means exactly this: the revision does not verify.
              // A revision that still has no citations — or invented ones —
              // is not an improvement, and the original answer stands.
              const better = !repairedCheck.hasUnverified && !repairedCheck.hasNoCitations;

              // The repair is a step like any other: it advances the step
              // number, accrues usage and tokens, and is audited with the
              // turn's correlation id. The row is identifiable — tool_args
              // names the repair and the step whose answer it revised — so
              // the audit trail can tell a repair from an ordinary
              // completion.
              stepNo = repairStepNo;
              inputTokens += repairedStep.message.usage?.input_tokens ?? 0;
              outputTokens += repairedStep.message.usage?.output_tokens ?? 0;
              if (repairedStep.attempts.length > 0) chainAttempts.push(...repairedStep.attempts);
              if (repairedStep.provider !== preferredProvider) fallbackSeen = true;
              lastAnsweredProvider = repairedStep.provider;
              lastAnsweredModel = repairedStep.model;

              await logLlmCall(request.supabase, {
                orgId: request.orgId,
                correlationId: request.correlationId,
                stepNo: repairStepNo,
                model: repairedStep.model,
                promptVersion: PROMPT_VERSION,
                inputTokens: repairedStep.message.usage?.input_tokens ?? null,
                outputTokens: repairedStep.message.usage?.output_tokens ?? null,
                latencyMs: now() - repairCalledAt,
                toolName: null,
                toolArgs: {
                  kind: "citation_repair",
                  for_step: originalStepNo,
                  reason: "uncited answer",
                },
                retrievedChunkIds: [...new Set(evidence.chunkIds)],
                outcome: "ok",
                provider: repairedStep.provider,
                preferredProvider,
              });

              if (better) lastText = repairedText;
            } catch (error) {
              // The client walked away mid-repair: the turn ends as
              // cancelled, audited, never as an answer.
              if (error instanceof RequestAbortedError || signal?.aborted) {
                return await finish(
                  CANCELLED,
                  lastText || "The request was cancelled.",
                  "cancelled by the client",
                );
              }
              // A chain that refused the repair is audited like the main
              // path audits one — but unlike the main path, where a chain
              // failure means no answer exists, the turn already has one, so
              // the original answer stands instead of a 429 the turn does
              // not need to die with.
              if (error instanceof ChainExhaustedError && request.chain) {
                chainAttempts.push(...error.attempts);
                await logLlmCall(request.supabase, {
                  orgId: request.orgId,
                  correlationId: request.correlationId,
                  stepNo: repairStepNo,
                  model: preferredModel,
                  promptVersion: PROMPT_VERSION,
                  inputTokens: 0,
                  outputTokens: 0,
                  latencyMs: now() - repairCalledAt,
                  toolName: null,
                  toolArgs: { kind: "citation_repair_failed", attempts: error.attempts },
                  retrievedChunkIds: [...new Set(evidence.chunkIds)],
                  outcome: "error",
                  provider: preferredProvider,
                  preferredProvider,
                });
              } else if (!(error instanceof ModelError)) {
                // A bug, not a provider problem: surface it. A provider
                // error on a single-model deployment is dropped the same way
                // as a chain failure — the repair is best-effort and the
                // answer already exists.
                throw error;
              }
              lastText = originalText;
            }
          } else {
            // Out of budget: no repair is attempted, and the original answer
            // stands, unverified, honestly.
            lastText = originalText;
          }
        }
      }

      return await finish("ok", lastText, null);
    }

    messages.push({ role: "assistant", content: response.content });

    // Parallel tool calls come back in one assistant message, and every
    // result has to go back in a single user message — splitting them
    // teaches the model to stop making parallel calls.
    const results: Anthropic.ToolResultBlockParam[] = [];
    const succeeded: Anthropic.ToolUseBlock[] = [];
    for (const use of toolUses) {
      toolsUsed.push(use.name);
      // AC-01: the reader sees the step start before it finishes.
      request.emit?.({ type: "step", stepNo, tool: use.name, args: use.input });
      try {
        const result = await trace(
          "agent.tool_call",
          () => runTool(toolContext, use.name, use.input),
          {
            traceId: request.correlationId,
            parent: request.parentSpan,
            attributes: { step_no: stepNo, tool: use.name },
          },
        );
        collectEvidence(use.name, result, evidence);
        request.emit?.({
          type: "tool_result",
          stepNo,
          tool: use.name,
          summary: summarizeToolResult(use.name, result),
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(result),
        });
        succeeded.push(use);
      } catch (error) {
        // A failed tool is reported to the model, not hidden from it — and
        // the attempt is audited either way, because an attempt that failed
        // is exactly what someone reconstructing an incident needs to see.
        const message = error instanceof Error ? error.message : String(error);
        request.emit?.({
          type: "tool_result",
          stepNo,
          tool: use.name,
          summary: "failed",
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: message,
          is_error: true,
        });
        await logAgentAction(request.supabase, {
          orgId: request.orgId,
          correlationId: request.correlationId,
          action: use.name,
          entity: "tool_call_failed",
          entityId: use.id,
          details: { args: use.input, step_no: stepNo, error: message },
        });
      }
    }

    // Outside the try on purpose. `logAgentAction` throws when the audit
    // write fails, and inside the try that throw was caught by the
    // tool-failure handler above — which then told the model a successful
    // tool had failed and wrote a `tool_call_failed` row for a call that
    // succeeded, masking the real cause behind a mislabelled trail.
    for (const use of succeeded) {
      await logAgentAction(request.supabase, {
        orgId: request.orgId,
        correlationId: request.correlationId,
        action: use.name,
        entity: "tool_call",
        entityId: use.id,
        details: { args: use.input, step_no: stepNo },
      });
    }

    stepNo++;
    if (evidence.anyData) emptySteps = 0;
    else emptySteps++;

    // US-06, as a mechanism rather than an instruction: with nothing to
    // answer from, the turn ends here — *before* the model is asked to
    // compose over an empty context. Asking a model not to hallucinate is a
    // request; not calling it is a guarantee.
    //
    // It waits for a second empty step, which the reviewer pass found
    // necessary. "Which invoices are overdue, and what is our late-fee
    // policy?" can start with a search for the policy; if the corpus has no
    // such document, abstaining right there throws away the half the agent
    // could have answered from `list_invoices`. One empty search is a clause
    // that found nothing; two consecutive steps with nothing to show is a
    // question this data cannot answer.
    if (evidence.searchedAndFoundNothing && !evidence.anyData && emptySteps >= EMPTY_STEPS_BEFORE_ABSTAINING) {
      return await finish("abstained", ABSTENTION_ANSWER, "retrieval returned nothing");
    }

    messages.push({ role: "user", content: results });
  }
}
