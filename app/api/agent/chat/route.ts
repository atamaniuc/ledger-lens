import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent/loop";
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
  const correlationId =
    req.headers.get("x-correlation-id") ?? body?.correlation_id ?? crypto.randomUUID();

  // Read under RLS, so this returns only orgs the user actually belongs to —
  // it is a lookup, not an authorization check.
  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("org_id")
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!membership) {
    return NextResponse.json({ error: "no organization for this user" }, { status: 403 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Named plainly rather than surfacing as a 500 from inside the SDK: an
    // unconfigured deployment is an operator problem, not a user's question.
    return NextResponse.json(
      { error: "the copilot is not configured on this deployment" },
      { status: 503 },
    );
  }

  try {
    const result = await runAgentTurn({
      question: question.trim(),
      orgId: membership.org_id,
      correlationId,
      supabase,
      anthropic: new Anthropic(),
    });

    return NextResponse.json({ correlation_id: correlationId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ correlation_id: correlationId, event: "agent_turn_failed", error: message }));
    return NextResponse.json(
      { error: "the copilot could not answer that", correlation_id: correlationId },
      { status: 500 },
    );
  }
}
