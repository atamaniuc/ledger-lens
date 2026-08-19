// The agent loop: bounded three ways, audited every step.
//
// ADR 0009. At most 6 tool-call steps, a 30-second wall-clock budget, and a
// token ceiling. Each bound ends the turn with a *stated reason* rather than
// a truncated answer that reads like a complete one, and the bounds are
// enforced here rather than inherited from the deploy platform's function
// timeout — so they hold identically on a laptop and on Vercel.
//
// The Anthropic client is injected so the tests can drive every termination
// path without a network call or an API key.

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { logAgentAction, logLlmCall, type StepOutcome } from "./audit";
import { AGENT_MODEL } from "./pricing";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import { runTool, toolDefinitions, type ToolContext } from "./tools";

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

export interface AgentTurnRequest {
  question: string;
  orgId: string;
  correlationId: string;
  supabase: SupabaseClient<Database>;
  anthropic: Anthropic;
  now?: () => number;
  limits?: Partial<{
    maxSteps: number;
    budgetMs: number;
    tokenCeiling: number;
  }>;
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
  usage: { inputTokens: number; outputTokens: number };
}

interface RetrievedEvidence {
  chunkIds: number[];
  invoiceExternalIds: string[];
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
    const chunks = (result as { chunks?: { chunk_id: number }[] }).chunks ?? [];
    for (const chunk of chunks) into.chunkIds.push(chunk.chunk_id);
  }
  if (toolName === "list_invoices") {
    const invoices = (result as { invoices?: { external_id: string }[] }).invoices ?? [];
    for (const invoice of invoices) into.invoiceExternalIds.push(invoice.external_id);
  }
  if (toolName === "draft_customer_email") {
    const invoice = (result as { invoice?: { external_id: string } }).invoice;
    if (invoice) into.invoiceExternalIds.push(invoice.external_id);
  }
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

  const startedAt = now();
  const toolContext: ToolContext = {
    supabase: request.supabase,
    orgId: request.orgId,
    correlationId: request.correlationId,
  };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: request.question },
  ];
  const evidence: RetrievedEvidence = { chunkIds: [], invoiceExternalIds: [] };
  const toolsUsed: string[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let stepNo = 0;
  let lastText = "";

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
        model: AGENT_MODEL,
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: now() - startedAt,
        toolName: null,
        toolArgs: null,
        retrievedChunkIds: null,
        outcome,
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
      },
    });

    return {
      answer,
      outcome,
      terminationReason,
      steps: stepNo,
      toolsUsed,
      retrievedChunkIds: [...new Set(evidence.chunkIds)],
      citedInvoiceIds: [...new Set(evidence.invoiceExternalIds)],
      usage: { inputTokens, outputTokens },
    };
  };

  for (;;) {
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
    const response = await request.anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_RESPONSE_TOKENS,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions() as Anthropic.Tool[],
      messages,
    });

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
      model: AGENT_MODEL,
      promptVersion: PROMPT_VERSION,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs: now() - calledAt,
      toolName: toolUses[0]?.name ?? null,
      toolArgs: toolUses.length > 0 ? toolUses.map((use) => use.input) : null,
      retrievedChunkIds: null,
      outcome: "ok",
    });

    if (toolUses.length === 0) {
      return await finish("ok", lastText, null);
    }

    messages.push({ role: "assistant", content: response.content });

    // Parallel tool calls come back in one assistant message, and every
    // result has to go back in a single user message — splitting them
    // teaches the model to stop making parallel calls.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolsUsed.push(use.name);
      try {
        const result = await runTool(toolContext, use.name, use.input);
        collectEvidence(use.name, result, evidence);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(result),
        });
        await logAgentAction(request.supabase, {
          orgId: request.orgId,
          correlationId: request.correlationId,
          action: use.name,
          entity: "tool_call",
          entityId: use.id,
          details: { args: use.input, step_no: stepNo },
        });
      } catch (error) {
        // A failed tool is reported to the model, not hidden from it — and
        // the attempt is audited either way, because an attempt that failed
        // is exactly what someone reconstructing an incident needs to see.
        const message = error instanceof Error ? error.message : String(error);
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

    messages.push({ role: "user", content: results });
    stepNo++;
  }
}
