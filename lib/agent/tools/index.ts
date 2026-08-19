// The registry. Four tools, and a test that counts them.
//
// US-04 is a countable claim — "exactly 4 tools: three read, one draft, and
// nothing capable of an irreversible side effect" — so a count is what keeps
// it one as the codebase grows. Adding a fifth entry here fails
// `registry.test.ts` until someone changes the number deliberately, which is
// the point at which ADR 0009 has to be revisited rather than quietly
// outgrown.

import { z } from "zod";
import { draftCustomerEmail } from "./draft-customer-email";
import { getRevenueSummary } from "./get-revenue-summary";
import { listInvoices } from "./list-invoices";
import { searchDocuments } from "./search-documents";
import type { AgentTool, ToolContext } from "./types";

export type { AgentTool, ToolContext, ToolEffect } from "./types";
export type { RevenueSummary, RevenueSummaryInput } from "./get-revenue-summary";
export type { ListInvoicesResult, ListedInvoice } from "./list-invoices";
export type { SearchDocumentsResult, SearchedChunk } from "./search-documents";
export type { CustomerEmailDraft } from "./draft-customer-email";

export const TOOLS: readonly AgentTool[] = [
  getRevenueSummary,
  listInvoices,
  searchDocuments,
  draftCustomerEmail,
] as const;

/** The number US-04 promises. Changing it is an ADR-level decision. */
export const TOOL_COUNT = 4;

export type ToolName = (typeof TOOLS)[number]["name"];

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

  return tool.execute(context, parsed.data);
}
