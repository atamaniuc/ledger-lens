// The registry. Four tools, and a test that counts them.
//
// US-04 is a countable claim — "exactly 4 tools: three read, one draft, and
// nothing capable of an irreversible side effect" — so a count is what keeps
// it one as the codebase grows. Adding a fifth entry here fails
// `registry.test.ts` until someone changes the number deliberately, which is
// the point at which ADR 0009 has to be revisited rather than quietly
// outgrown.

import { z } from "zod";
import { assertCanDraft } from "../rbac";
import { draftCustomerEmail } from "./draft-customer-email";
import { getRevenueSummary } from "./get-revenue-summary";
import { listInvoices } from "./list-invoices";
import { searchDocuments } from "./search-documents";
import type { AgentTool, ToolContext } from "./types";

export type { AgentTool, ToolContext } from "./types";
export type { CustomerEmailDraft } from "./draft-customer-email";

// Two rules about the published tool schemas, both learned the hard way from
// running Stage 6's eval set against Groq — which, unlike Anthropic,
// validates tool arguments against the schema *server-side* before the call
// ever reaches this process. A violation there is not a tool error the model
// can read and correct; it is a 400 that ends the turn.
//
// **1. Every optional parameter is `.nullish()`, not `.optional()`.** Models
// routinely fill an omitted optional with an explicit `null`, and a schema
// that says `{"type":"string"}` rejects that. `get_revenue_summary` failed on
// every metric case while working perfectly on Anthropic. The tools already
// read their arguments with `??` and truthiness, so `null` and absent meant
// the same thing here; only the published schema disagreed.
//
// **2. Value bounds live in the tool body, not in the schema.** `search_documents`
// declared `limit` as at most 8; a model asked for 10 and the request was
// rejected outright. The bound is ours to enforce and it still is — clamped
// in `./clamp.ts`, with the limit stated in the parameter's description so
// the model knows it. What changed is the failure mode: a clamp or a tool
// error the model can retry, instead of a dead turn. The same applies to
// string lengths and to the date format, which is now checked in the body and
// reported by name.
//
// The types stay in the schema. `limit` is still a number and `status` is
// still one of four values — those are what the schema is for, and a model
// that gets them wrong has misunderstood the tool rather than overshot a
// bound.

export const TOOLS: readonly AgentTool[] = [
  getRevenueSummary,
  listInvoices,
  searchDocuments,
  draftCustomerEmail,
] as const;

/** The number US-04 promises. Changing it is an ADR-level decision. */
export const TOOL_COUNT = 4;

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): AgentTool | undefined {
  return BY_NAME.get(name);
}

/** The Anthropic tool definition, derived from the Zod schema — one definition, not two. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toolDefinitions(): AnthropicToolDefinition[] {
  return TOOLS.map((tool) => {
    const schema = z.toJSONSchema(tool.input, { target: "draft-2020-12" }) as Record<
      string,
      unknown
    >;
    // The API wants a plain object schema; `$schema` is noise on the wire and
    // changes the cached prefix if the Zod version bumps it.
    delete schema.$schema;
    return { name: tool.name, description: tool.description, input_schema: schema };
  });
}

export class ToolExecutionError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.toolName = toolName;
  }
}

/**
 * Validates the model's arguments against the tool's own schema before
 * running it. A model can emit anything; the schema is what decides whether
 * it reaches a query.
 */
export async function runTool(
  context: ToolContext,
  name: string,
  args: unknown,
): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new ToolExecutionError(name, `no tool named ${name}`);

  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ToolExecutionError(name, `invalid arguments: ${parsed.error.issues[0]?.message}`);
  }

  // D-08: a viewer may read but may not invoke a write-adjacent tool. This is
  // an additional gate in the one place every tool call must pass, not a
  // replacement for the registry's effect allowlist (US-04). The database
  // stamps the caller's own role, so no argument the model produces can
  // change the answer. Read tools never pay this round trip.
  if (tool.effect === "draft") {
    await assertCanDraft(context.supabase, context.orgId);
  }

  return tool.execute(context, parsed.data);
}
