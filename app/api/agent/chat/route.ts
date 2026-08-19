import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent/loop";
import { ModelError, createModelClient, providerSummary } from "@/lib/agent/providers";
import { createClient } from "@/lib/supabase/server-client";

// Stage 5's chat entry point. ADR 0009: the agent runs under the calling
// user's JWT, using the same cookie-backed client the dashboard reads with,
// and holds no service-role credential — so a tool cannot reach a row this
// user's own dashboard could not.
//
// This is a route handler rather than a Server Component read because it is a
// write-shaped operation with a model call in the middle. ADR 0007's rule
// still stands: dashboard *reads* go direct, with no BFF in front of them.

export const runtime = "nodejs";

const MAX_QUESTION_CHARS = 1_000;

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
  // Validated rather than taken as given. `body.correlation_id` is whatever
  // JSON the caller sent: an object or a number reaches `log_llm_call`, whose
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

  // Any configured provider will do — Anthropic, or one of the free
  // OpenAI-compatible tiers. The agent's safety properties do not come from
  // the vendor (ADR 0009), so this is configuration rather than a decision.
  const model = createModelClient();
  if (!model) {
    // Named plainly rather than surfacing as a 500 from inside a client: an
    // unconfigured deployment is an operator problem, not a user's question.
    return NextResponse.json(
      {
        error: "the copilot is not configured on this deployment",
        detail: providerSummary(),
      },
      { status: 503 },
    );
  }

  try {
    const result = await runAgentTurn({
      question: question.trim(),
      orgId: membership.org_id,
      correlationId,
      supabase,
      model,
    });

    return NextResponse.json({ correlation_id: correlationId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
