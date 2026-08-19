// The agent's two writers.
//
// Both go through `SECURITY DEFINER` functions (migration 20260819190000)
// because neither table grants INSERT to `authenticated` — the agent runs as
// the user, and a user must not be able to write their own audit trail.
//
// **A failed audit write fails the turn.** The PRD's counter-metric for this
// stage is "zero unaudited agent actions", and swallowing the error would
// trade that guarantee for one answer. The caller surfaces it rather than
// pretending the step did not happen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { costCents } from "./pricing";

export type StepOutcome =
  | "ok"
  | "abstained"
  | "step_cap"
  | "timeout"
  | "token_ceiling"
  | "error";

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

export interface LlmCallRecord {
  orgId: string;
  correlationId: string;
  stepNo: number;
  model: string;
  promptVersion: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  toolName?: string | null;
  toolArgs?: unknown;
  retrievedChunkIds?: number[] | null;
  outcome: StepOutcome;
}

export interface AgentActionRecord {
  orgId: string;
  correlationId: string;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  details?: unknown;
}

/** Records one model call — its tokens, its cost at today's prices, and how it ended. */
export async function logLlmCall(
  supabase: SupabaseClient,
  record: LlmCallRecord,
): Promise<number> {
  const cost = costCents(record.model, record.inputTokens, record.outputTokens);
  if (cost === null) {
    // Visible rather than silent: the row still lands, with a null cost.
    console.warn(
      JSON.stringify({
        correlation_id: record.correlationId,
        event: "llm_call_unpriced_model",
        model: record.model,
      }),
    );
  }

  const { data, error } = await supabase.rpc("log_llm_call", {
    p_org_id: record.orgId,
    p_correlation_id: record.correlationId,
    p_step_no: record.stepNo,
    p_model: record.model,
    p_prompt_version: record.promptVersion,
    p_input_tokens: record.inputTokens ?? null,
    p_output_tokens: record.outputTokens ?? null,
    p_cost_cents: cost,
    p_latency_ms: record.latencyMs ?? null,
    p_tool_name: record.toolName ?? null,
    p_tool_args: (record.toolArgs ?? null) as never,
    p_retrieved_chunk_ids: record.retrievedChunkIds ?? null,
    p_outcome: record.outcome,
  });

  if (error) throw new AuditError(`log_llm_call failed: ${error.message}`);
  return data as number;
}

/**
 * Records one thing the agent did on the user's behalf. `actor_type` and
 * `on_behalf_of` are not parameters — the database stamps them from
 * `auth.uid()`, so a caller cannot name someone else.
 */
export async function logAgentAction(
  supabase: SupabaseClient,
  record: AgentActionRecord,
): Promise<number> {
  const { data, error } = await supabase.rpc("log_agent_action", {
    p_org_id: record.orgId,
    p_correlation_id: record.correlationId,
    p_action: record.action,
    p_entity: record.entity ?? null,
    p_entity_id: record.entityId ?? null,
    p_details: (record.details ?? null) as never,
  });

  if (error) throw new AuditError(`log_agent_action failed: ${error.message}`);
  return data as number;
}
