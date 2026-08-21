import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAgentBudget } from "@/features/agent/budget";
import {
  runAgentTurn,
  type AgentStepEvent,
  type AgentTurnResult,
  type ConversationTurn,
} from "@/features/agent/loop";
import {
  ChainExhaustedError,
  ModelError,
  createModelChain,
  providerSummary,
  type ProviderSpec,
} from "@/features/agent/providers";
import { demoAnswer, demoFallbackAnswer } from "@/features/agent/demo-answer";
import { getCopilotSettings, type CopilotSettings } from "@/features/admin/copilot-settings";
import { endSpan, startSpan } from "@/platform/obs";
import { createClient } from "@/platform/supabase/server-client";
import type { Database } from "@/platform/supabase/database.types";

// Stage 5's chat entry point. ADR 0009: the agent runs under the calling
// user's JWT, using the same cookie-backed client the dashboard reads with,
// and holds no service-role credential — so a tool cannot reach a row this
// user's own dashboard could not.
//
// Spec 0013 turns this into one loop with two transports: the same turn runs
// either as a single JSON body (the eval runner and every pre-existing test
// call exactly this path, byte for byte) or as an SSE stream of step events
// when the client asks for `text/event-stream`. The gates in front of the
// loop — auth, validation, the chain config, the budget — are identical on
// both transports; only the answer's wire format differs.
//
// This is a route handler rather than a Server Component read because it is a
// write-shaped operation with a model call in the middle. ADR 0007's rule
// still stands: dashboard *reads* go direct, with no BFF in front of them.

export const runtime = "nodejs";

const MAX_QUESTION_CHARS = 1_000;
/**
 * A conversation id the client may name on follow-ups (AC-03). Validated
 * here as a UUID; the database functions then check it against the caller's
 * org — the client names the conversation, never the rows it may see (ADR
 * 0009).
 */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The generated Database types do not know the memory RPCs yet (they are
// regenerated from the schema at integration). Narrow, locally typed channel
// — same pattern as the budget gate in ./budget.ts and the RBAC gate in
// ../rbac.ts.
interface MemoryRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * AC-03's read: the prior turns of a conversation, re-fetched from the
 * database under the caller's membership — never replayed from the request,
 * because the client is untrusted input (ADR 0009). Returns rows oldest
 * first; the loop applies its token budget.
 */
async function fetchConversationHistory(
  supabase: SupabaseClient<Database>,
  orgId: string,
  conversationId: string,
): Promise<ConversationTurn[]> {
  const { data, error } = await (supabase as unknown as MemoryRpc).rpc(
    "get_conversation_history",
    { p_org_id: orgId, p_conversation_id: conversationId },
  );
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data)
    ? (data as { question?: unknown; answer?: unknown }[])
    : [];
  return rows
    .filter((row) => typeof row.question === "string" && typeof row.answer === "string")
    .map((row) => ({ question: row.question as string, answer: row.answer as string }));
}

async function saveConversationTurn(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    conversationId: string;
    correlationId: string;
    question: string;
    answer: string;
    outcome: string;
  },
): Promise<void> {
  const { error } = await (supabase as unknown as MemoryRpc).rpc("save_conversation_turn", {
    p_org_id: args.orgId,
    p_conversation_id: args.conversationId,
    p_correlation_id: args.correlationId,
    p_question: args.question,
    p_answer: args.answer,
    p_outcome: args.outcome,
  });
  if (error) throw new Error(error.message);
}

/**
 * Remembers a delivered turn so a follow-up can see it (AC-03). Only turns
 * that produced a deliverable answer are remembered — a cancelled or bound
 * turn is audited in llm_calls, never stored as an answer a follow-up could
 * be built on (US-04). Memory is an enhancement, not a gate: a persistence
 * failure must not fail a turn whose answer was already delivered, so it is
 * logged under its own event rather than thrown.
 */
async function persistTurnIfDeliverable(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    conversationId: string | undefined;
    correlationId: string;
    question: string;
    result: { outcome: string; answer: string };
  },
): Promise<void> {
  if (!args.conversationId) return;
  if (args.result.outcome !== "ok" && args.result.outcome !== "abstained") return;
  try {
    await saveConversationTurn(supabase, {
      orgId: args.orgId,
      conversationId: args.conversationId,
      correlationId: args.correlationId,
      question: args.question,
      answer: args.result.answer,
      outcome: args.result.outcome,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        correlation_id: args.correlationId,
        event: "agent_history_save_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Every message a streaming client can receive: the loop's progressive events, then the verdict. */
type StreamOutgoing =
  | AgentStepEvent
  | { type: "done"; result: Record<string, unknown> }
  | { type: "error"; error: string; [key: string]: unknown };

/**
 * The streaming transport (AC-01). All the gates have already passed; this
 * runs the same turn the JSON path runs, but hands every step event to the
 * client as SSE as it happens, and ends with a `done` event carrying the
 * full result (the same object the JSON path returns, plus correlation_id).
 *
 * Cancellation (AC-02): the request's own signal and the response stream's
 * `cancel` both feed one AbortController that the loop races against, so a
 * client that disconnects stops the turn within one step and is audited as
 * `cancelled`. Errors that would be a 429/502/500 on the JSON path become
 * an `error` event with the same distinguishable fields, and the stream
 * closes.
 */
function streamResponse(opts: {
  req: NextRequest;
  supabase: SupabaseClient<Database>;
  orgId: string;
  correlationId: string;
  chain: NonNullable<ReturnType<typeof createModelChain>>;
  question: string;
  history: ConversationTurn[];
  conversationId: string | undefined;
  /** D-53: when true, a spent chain ends as a deterministic demo answer. */
  demoMode: boolean;
}): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  // A client that was already gone when the stream was built must still stop
  // the turn — the listener below never fires for a signal that already
  // fired, so the already-aborted state is carried over explicitly.
  if (opts.req.signal.aborted) abort.abort();
  opts.req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const turnSpan = startSpan("agent.turn", {
        traceId: opts.correlationId,
        kind: "server",
        attributes: { org_id: opts.orgId },
      });
      const emit = (event: StreamOutgoing) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client is gone; the abort wiring above stops the turn.
        }
      };

      try {
        const result = await runAgentTurn({
          question: opts.question,
          orgId: opts.orgId,
          correlationId: opts.correlationId,
          supabase: opts.supabase,
          chain: opts.chain,
          parentSpan: turnSpan,
          history: opts.history,
          stream: true,
          signal: abort.signal,
          emit: (event) => emit(event),
        });
        endSpan(turnSpan, "ok");
        await persistTurnIfDeliverable(opts.supabase, {
          orgId: opts.orgId,
          conversationId: opts.conversationId,
          correlationId: opts.correlationId,
          question: opts.question,
          result,
        });
        // The last event is the full result — the same shape the JSON path
        // returns, so one client-side answer renderer serves both.
        emit({ type: "done", result: { correlation_id: opts.correlationId, ...result } });
        controller.close();
      } catch (error) {
        endSpan(turnSpan, "error", error);
        const message = error instanceof Error ? error.message : String(error);

        // ADR 0010: every provider tried and none answered. Same shape as the
        // JSON path's 429, delivered as an event because the stream already
        // started.
        if (error instanceof ChainExhaustedError) {
          console.error(
            JSON.stringify({
              correlation_id: opts.correlationId,
              event: "agent_chain_exhausted",
              error: message,
              attempts: error.attempts,
            }),
          );
          // D-53: demo mode delivers the deterministic answer as the stream's
          // final event instead of an error — the reader never sees "try
          // again later" on a stage.
          if (opts.demoMode) {
            const demo = await buildDemoAnswer(
              opts.question,
              opts.supabase,
              opts.orgId,
              opts.correlationId,
            );
            emit({ type: "done", result: { correlation_id: opts.correlationId, ...demo } });
            controller.close();
            return;
          }
          emit({
            type: "error",
            error:
              "every provider in the copilot's failover chain is rate-limited or unreachable right now",
            chain_exhausted: true,
            chain: opts.chain.names,
            attempts: error.attempts,
            detail: message,
            ...(error.retryAfterMs
              ? { retry_after_seconds: Math.ceil(error.retryAfterMs / 1000) }
              : {}),
            correlation_id: opts.correlationId,
          });
        } else if (error instanceof ModelError) {
          const rateLimited = error.status === 429;
          emit({
            type: "error",
            error: rateLimited
              ? "the copilot is rate-limited by its model provider right now"
              : "the copilot's model provider rejected the request",
            detail: message,
            ...(error.retryAfterMs
              ? { retry_after_seconds: Math.ceil(error.retryAfterMs / 1000) }
              : {}),
            correlation_id: opts.correlationId,
          });
        } else {
          emit({
            type: "error",
            error: "the copilot could not answer that",
            correlation_id: opts.correlationId,
          });
        }
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the runtime.
        }
      }
    },
    cancel() {
      // The client disconnected: stop the turn, which the loop audits as
      // `cancelled` (AC-02).
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();

  // getUser, not getSession: it verifies the JWT with the auth server instead
  // of trusting a cookie this request could have forged.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const question: unknown = body?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `question must be at most ${MAX_QUESTION_CHARS} characters` },
      { status: 400 },
    );
  }

  // CLAUDE.md: one correlation_id per request chain, accepted from the caller
  // or minted here, and carried by every llm_calls and audit_log row below.
  //
  // Validated rather than taken as given. `body.correlation_id` is whatever JSON
  // the caller sent: an object or a number reaches `log_llm_call`, whose
  // column is `text`, and comes back as a 500 on every request from that
  // client. An over-long or arbitrary value also lets a caller shadow another
  // request's chain in the logs.
  const supplied = req.headers.get("x-correlation-id") ?? body?.correlation_id;
  const correlationId =
    typeof supplied === "string" && /^[\w.:-]{1,128}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();

  // Read under RLS, so this returns only orgs the user actually belongs to —
  // it is a lookup, not an authorization check.
  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .limit(2);

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: "no organization for this user" }, { status: 403 });
  }
  // Refused rather than guessed. The tools carry no `org_id` filter — RLS
  // decides what they see — so for a user in two orgs the answer would be
  // built from both while every llm_calls and audit_log row got stamped with
  // whichever one an arbitrary `limit(1)` happened to return. That is a
  // silently misattributed audit trail, against the PRD's "zero unaudited
  // agent actions". Choosing an org is a Stage 6 feature; until it exists,
  // saying so is the honest answer.
  if (memberships.length > 1) {
    return NextResponse.json(
      { error: "this account belongs to more than one organization, which the copilot cannot scope to yet" },
      { status: 409 },
    );
  }
  const membership = memberships[0];

  // D-53: runtime copilot settings — guards flag, demo mode, providers added
  // in the admin panel. Read through the user's own RPC (SECURITY DEFINER,
  // membership-checked); a failure here must not take the copilot down, so
  // the route falls back to the safe defaults: guards on, demo off.
  let settings: CopilotSettings = { guardsEnabled: true, demoMode: false, providers: [] };
  try {
    settings = await getCopilotSettings(supabase, membership.org_id);
  } catch (error) {
    console.error(
      JSON.stringify({
        correlation_id: correlationId,
        event: "copilot_settings_unreadable",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // ADR 0010: the deployment's failover chain — an ordered preference list
  // (LLM_CHAIN=groq,nvidia), or the single configured provider when no chain
  // is set. Runtime providers from the admin panel (D-53) join after the
  // environment-configured ones, so an operator can add an OpenAI-compatible
  // provider without touching a deployment. The agent's safety properties do
  // not come from the vendor (ADR 0009). The chain shares one process-local
  // cooldown map across requests.
  const runtimeSpecs: ProviderSpec[] = settings.providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      name: "runtime-" + provider.id,
      keyVar: provider.keyName,
      baseUrl: provider.baseUrl,
      defaultModel: provider.model,
      modelVar: "",
    }));
  let chain;
  try {
    chain = createModelChain(runtimeSpecs);
  } catch (error) {
    // A malformed or incompletely configured LLM_CHAIN fails loudly (ADR
    // 0010) rather than quietly shortening the chain — the operator gets a
    // response that names the problem, and the log gets its own event.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ correlation_id: correlationId, event: "agent_chain_config_invalid", error: message }),
    );
    return NextResponse.json(
      { error: "the copilot's model chain is misconfigured", detail: message, correlation_id: correlationId },
      { status: 500 },
    );
  }
  if (!chain) {
    // Named plainly rather than surfacing as a 500 from inside a client: an
    // unconfigured deployment is an operator problem, not a user's question.
    // Checked before the budget on purpose: a deployment that cannot answer
    // must not spend its users' quota on 503s.
    //
    // Demo mode (D-53) is the one exception to the 503: a presentation must
    // not end on "not configured", so the copilot answers deterministically
    // from this tenant's real data instead.
    if (settings.demoMode) {
      return demoResponse(
        await buildDemoAnswer(question, supabase, membership.org_id, correlationId),
        correlationId,
      );
    }
    return NextResponse.json(
      {
        error: "the copilot is not configured on this deployment",
        detail: providerSummary(),
      },
      { status: 503 },
    );
  }

  // D-18: the per-user / per-org request limits and the daily cost cap,
  // counted in Postgres (migration 20260821100000) so they hold across every
  // instance. A refusal is a verdict with its own status — 429 for a request
  // limit, 402 for the spend cap — and always carries the retry_after fields
  // the acceptance criteria name. It is never collapsed into the generic 500
  // below, and a database failure in the check itself is named as such
  // rather than silently letting the request through.
  //
  // D-53: guards_enabled=false switches the gate off entirely — a
  // presentation, a stress test, or a demo where the guard must not
  // interrupt. The guard stays the default; turning it off is an operator
  // decision recorded in copilot_settings.
  const budget = settings.guardsEnabled
    ? await checkAgentBudget(supabase, membership.org_id)
    : { allowed: true as const };

  if (!budget.allowed) {
    // ADR 0010: this refusal is what the chain-exhausted 429 must be
    // distinguishable from — budget refusals carry retry_after/resets_at and
    // are logged under their own event, before any model call is made.
    //
    // D-53: demo mode never shows a budget error either. The guard still
    // logs the refusal; the reader gets the deterministic answer instead.
    if (settings.demoMode) {
      console.warn(
        JSON.stringify({
          correlation_id: correlationId,
          event: "agent_budget_refused_demo_fallback",
          reason: budget.reason,
        }),
      );
      return demoResponse(
        await buildDemoAnswer(question, supabase, membership.org_id, correlationId),
        correlationId,
      );
    }
    console.warn(
      JSON.stringify({
        correlation_id: correlationId,
        event: "agent_budget_refused",
        reason: budget.reason,
        scope: budget.scope ?? null,
      }),
    );
    const limited = budget.reason === "rate_limit";
    const body = {
      error: limited
        ? budget.scope === "org"
          ? "this organization has sent too many copilot requests"
          : "you have sent too many copilot requests"
        : budget.reason === "token_cap"
          ? "this organization has reached its daily token budget for the copilot"
          : "this organization has reached its daily budget for the copilot",
      // retry_after_seconds matches the provider-429 mapping below;
      // retry_after is the name the spec's acceptance criteria use.
      retry_after: budget.retryAfterSeconds,
      retry_after_seconds: budget.retryAfterSeconds,
      resets_at: budget.resetsAt,
      correlation_id: correlationId,
    };
    return NextResponse.json(body, { status: limited ? 429 : 402 });
  }

  // AC-03: a follow-up names its conversation; the history is re-fetched from
  // the database under the caller's membership, then bounded in the loop.
  // The read is an enhancement, not a gate: a failure here must not fail the
  // question, so it is logged and the turn proceeds with no history.
  const conversationId =
    typeof body?.conversation_id === "string" && CONVERSATION_ID_RE.test(body.conversation_id)
      ? body.conversation_id
      : undefined;
  let history: ConversationTurn[] = [];
  if (conversationId) {
    try {
      history = await fetchConversationHistory(supabase, membership.org_id, conversationId);
    } catch (error) {
      console.error(
        JSON.stringify({
          correlation_id: correlationId,
          event: "agent_history_read_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // AC-01: content negotiation. `Accept: text/event-stream` streams step
  // events as they happen; anything else keeps the single-JSON-body contract
  // the eval runner and every pre-existing test depend on.
  const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");

  if (wantsStream) {
    return streamResponse({
      req,
      supabase,
      orgId: membership.org_id,
      correlationId,
      chain,
      question: question.trim(),
      history,
      conversationId,
      demoMode: settings.demoMode,
    });
  }

  // One trace per turn, its id the correlation_id every log line already
  // carries, so a span and a log line can be joined without a vendor (D-45).
  const turnSpan = startSpan("agent.turn", {
    traceId: correlationId,
    kind: "server",
    attributes: { org_id: membership.org_id },
  });
  try {
    const result = await runAgentTurn({
      question: question.trim(),
      orgId: membership.org_id,
      correlationId,
      supabase,
      chain,
      parentSpan: turnSpan,
      history,
    });
    endSpan(turnSpan, "ok");
    await persistTurnIfDeliverable(supabase, {
      orgId: membership.org_id,
      conversationId,
      correlationId,
      question: question.trim(),
      result,
    });

    // ADR 0010: the response names the provider that answered and whether
    // the turn fell back off the preferred one — degradation is surfaced,
    // never hidden.
    return NextResponse.json({ correlation_id: correlationId, ...result });
  } catch (error) {
    endSpan(turnSpan, "error", error);
    const message = error instanceof Error ? error.message : String(error);

    // ADR 0010: every provider tried and none answered. Checked before the
    // generic ModelError branch (it extends it), and deliberately shaped so
    // it cannot be confused with the budget gate's 429: chain_exhausted is
    // true, the chain and the attempts are named, and there is no resets_at.
    if (error instanceof ChainExhaustedError) {
      console.error(
        JSON.stringify({
          correlation_id: correlationId,
          event: "agent_chain_exhausted",
          error: message,
          attempts: error.attempts,
        }),
      );
      // D-53: demo mode turns "every provider is spent" into a deterministic
      // answer from this tenant's real data. The guard still logged the
      // exhaustion; the reader just never sees "try again in 27 minutes".
      if (settings.demoMode) {
        return demoResponse(
          await buildDemoAnswer(question, supabase, membership.org_id, correlationId),
          correlationId,
        );
      }
      return NextResponse.json(
        {
          error:
            "the copilot's free model tier has used its daily allowance — this is the guard working, not a breakage",
          chain_exhausted: true,
          chain: chain.names,
          attempts: error.attempts,
          detail: message,
          ...(error.retryAfterMs
            ? { retry_after_seconds: Math.ceil(error.retryAfterMs / 1000) }
            : {}),
          correlation_id: correlationId,
        },
        { status: 429 },
      );
    }

    console.error(
      JSON.stringify({ correlation_id: correlationId, event: "agent_turn_failed", error: message }),
    );

    // A provider fault is not the same thing as a bug here, and collapsing
    // both into "the copilot could not answer that" is what made a free
    // tier's token-per-minute limit look like a broken deployment. The
    // provider's own message is operator-facing detail — it carries a status
    // and a wait, never a credential.
    if (error instanceof ModelError) {
      const rateLimited = error.status === 429;
      return NextResponse.json(
        {
          error: rateLimited
            ? "the copilot is rate-limited by its model provider right now"
            : "the copilot's model provider rejected the request",
          detail: error.message,
          ...(error.retryAfterMs
            ? { retry_after_seconds: Math.ceil(error.retryAfterMs / 1000) }
            : {}),
          correlation_id: correlationId,
        },
        { status: rateLimited ? 429 : 502 },
      );
    }

    return NextResponse.json(
      { error: "the copilot could not answer that", correlation_id: correlationId },
      { status: 500 },
    );
  }
}

// D-53: the demo-mode answer path. Runs the same tools the agent would use,
// under the caller's JWT, and returns the answer marked `demo: true` so the
// panel can say so. Used when demo mode is on and there is either no
// configured chain or every provider in it is spent.
async function buildDemoAnswer(
  question: string,
  supabase: SupabaseClient<Database>,
  orgId: string,
  correlationId: string,
): Promise<AgentTurnResult & { demo: true }> {
  const ctx = { supabase, orgId, correlationId };
  const intent = await demoAnswer(question, ctx);
  if (intent) {
    return {
      answer: intent.answer,
      outcome: "ok",
      terminationReason: null,
      steps: 0,
      toolsUsed: intent.toolsUsed,
      retrievedChunkIds: intent.retrievedChunkIds,
      citedInvoiceIds: intent.citedInvoiceIds,
      citations: intent.citations,
      verified: intent.citations.length > 0 && intent.citations.every((c) => c.verified),
      uncited: intent.citations.length === 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: null,
      model: null,
      fallback: false,
      chainAttempts: [],
      demo: true,
    };
  }
  return demoFallbackAnswer();
}

function demoResponse(
  result: AgentTurnResult & { demo: true },
  correlationId: string,
): NextResponse {
  return NextResponse.json({ correlation_id: correlationId, ...result });
}
