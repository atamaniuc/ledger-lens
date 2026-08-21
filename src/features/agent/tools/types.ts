// What a tool is in this system.
//
// ADR 0009: every tool executes with the caller's own Supabase client, so RLS
// decides what it can reach. No tool takes an `org_id` — the one on the
// context is for audit rows, never for a query filter, because a filter the
// caller supplies is not an authorization check.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import type { Database } from "@/platform/supabase/database.types";

export interface ToolContext {
  /** Built from the user's JWT. The only credential in the chat path. */
  supabase: SupabaseClient<Database>;
  /** The org whose audit rows this turn writes. Resolved once, under RLS. */
  orgId: string;
  correlationId: string;
}

/**
 * `read` tools query. `draft` tools compose text and return it.
 *
 * There is no third kind, and adding one is the thing US-04 is a claim about:
 * nothing in this repository can send, write or reach the network on the
 * agent's behalf.
 */
type ToolEffect = "read" | "draft";

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  effect: ToolEffect;
  input: z.ZodType<TInput>;
  execute(context: ToolContext, input: TInput): Promise<TOutput>;
}
