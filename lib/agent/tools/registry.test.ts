import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../supabase/database.types";
import { TOOLS, TOOL_COUNT, ToolExecutionError, findTool, runTool, toolDefinitions } from ".";
import type { ToolContext } from "./types";

const context = (supabase: unknown): ToolContext => ({
  supabase: supabase as SupabaseClient<Database>,
  orgId: "00000000-0000-4000-8000-000000000001",
  correlationId: "corr-1",
});

describe("the registry", () => {
  it("holds exactly four tools", () => {
    // US-04 is a countable claim. This is what keeps it one.
    expect(TOOLS).toHaveLength(TOOL_COUNT);
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([
      "draft_customer_email",
      "get_revenue_summary",
      "list_invoices",
      "search_documents",
    ]);
  });

  it("has no tool that writes, sends or reaches the network", () => {
    // The safety claim in ADR 0009 is about capability, not instruction. Any
    // new effect kind is a decision that has to be made in the ADR first.
    for (const tool of TOOLS) {
      expect(["read", "draft"]).toContain(tool.effect);
    }
    expect(TOOLS.filter((tool) => tool.effect === "draft")).toHaveLength(1);
  });

  it("describes every tool for the model", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("derives one JSON schema per tool from its Zod schema", () => {
    const definitions = toolDefinitions();
    expect(definitions).toHaveLength(TOOL_COUNT);
    for (const definition of definitions) {
      expect(definition.input_schema.type).toBe("object");
      expect(definition.input_schema.$schema).toBeUndefined();
      expect(definition.input_schema).toHaveProperty("properties");
    }
  });

  it("does not find a tool that was never defined", () => {
    expect(findTool("send_email")).toBeUndefined();
    expect(findTool("delete_invoice")).toBeUndefined();
  });
});

describe("runTool", () => {
  it("refuses an unknown tool name", async () => {
    await expect(runTool(context({}), "send_email", {})).rejects.toThrow(ToolExecutionError);
  });

  it("rejects arguments of the wrong type, before any query runs", async () => {
    // A model can emit anything. The schema is what decides whether it
    // reaches Postgres — for *types*. Values out of range are a different
    // case, asserted below.
    let queried = false;
    const supabase = {
      from() {
        queried = true;
        throw new Error("should not have been called");
      },
    };

    await expect(
      runTool(context(supabase), "list_invoices", { status: "deleted" }),
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      runTool(context(supabase), "list_invoices", { limit: "ten" }),
    ).rejects.toThrow(ToolExecutionError);
    expect(queried).toBe(false);
  });

  it("clamps a limit past the cap instead of rejecting the call", async () => {
    // The bound still holds — it is enforced in the tool body. What changed
    // is the failure mode: a provider that validates the schema server-side
    // turns an overshoot into a 400 that ends the turn, so the cap moved
    // out of the published schema and into ./clamp.ts.
    let requested: number | undefined;
    const builder = {
      select: () => builder,
      order: () => builder,
      eq: () => builder,
      ilike: () => builder,
      limit: (value: number) => {
        requested = value;
        return builder;
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    };
    const supabase = { from: () => builder };

    await runTool(context(supabase), "list_invoices", { limit: 500 });

    // 20 rows plus the one-row probe the tool uses to report truncation.
    expect(requested).toBe(21);
  });

  it("passes validated arguments through to the tool", async () => {
    const calls: { column: string; value: unknown }[] = [];
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: (column: string, value: unknown) => {
        calls.push({ column, value });
        return builder;
      },
      ilike: (column: string, value: unknown) => {
        calls.push({ column, value });
        return builder;
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    };
    const supabase = { from: () => builder };

    await runTool(context(supabase), "list_invoices", { status: "paid", customer: "North" });

    expect(calls).toContainEqual({ column: "status", value: "paid" });
    expect(calls).toContainEqual({ column: "customer", value: "%North%" });
  });

  it("escapes wildcards in a customer filter", async () => {
    // Without this, a customer name containing % or _ silently becomes a
    // wildcard search across the tenant's whole invoice list.
    const calls: { column: string; value: unknown }[] = [];
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: () => builder,
      ilike: (column: string, value: unknown) => {
        calls.push({ column, value });
        return builder;
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    };

    await runTool(context({ from: () => builder }), "list_invoices", { customer: "100%_pure" });

    expect(calls[0].value).toBe("%100\\%\\_pure%");
  });

  it("never takes an org_id from the model", () => {
    // Every tool's schema is the model's entire influence over the query, and
    // none of them accepts a tenant selector — RLS decides, not the caller.
    for (const definition of toolDefinitions()) {
      const properties = definition.input_schema.properties as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain("org_id");
      expect(Object.keys(properties)).not.toContain("organization_id");
    }
  });
});

describe("tool schemas as a provider sees them", () => {
  // Groq (and other OpenAI-compatible providers) validate tool arguments
  // against the published schema before the call reaches this process. A
  // model filling an omitted optional with an explicit `null` is routine, so
  // a schema that only permits the base type turns a working tool into a 400
  // — which is exactly what happened, on every `get_revenue_summary` case,
  // while the same tool worked on Anthropic.
  const optionalFields: Record<string, string[]> = {
    get_revenue_summary: ["status", "issued_from", "issued_to"],
    list_invoices: ["status", "customer", "external_id", "limit"],
    search_documents: ["limit"],
    draft_customer_email: ["note"],
  };

  it("publishes no value bound a strict provider could reject a call over", () => {
    // Bounds belong in the body (./clamp.ts), where exceeding one is a clamp
    // or a correctable tool error. In the schema, a provider that validates
    // server-side turns the same overshoot into a 400 that ends the turn —
    // which is exactly what a model asking for `limit: 10` did.
    const published = JSON.stringify(toolDefinitions().map((tool) => tool.input_schema));

    for (const keyword of ["maxLength", "minLength", "pattern"]) {
      expect(published, keyword).not.toContain(`"${keyword}"`);
    }

    // `minimum`/`maximum` survive only as Zod's safe-integer sentinels, which
    // no model overshoots. Any *authored* numeric bound would appear here as
    // some other value.
    for (const bound of published.match(/"(?:minimum|maximum)":(-?\d+)/g) ?? []) {
      expect(Math.abs(Number(bound.split(":")[1]))).toBe(Number.MAX_SAFE_INTEGER);
    }

    // The types are still declared — that is what the schema is for.
    expect(published).toContain('"enum"');
    expect(published).toContain('"integer"');
  });

  for (const definition of toolDefinitions()) {
    it(`${definition.name} accepts null for every optional parameter`, () => {
      const schema = definition.input_schema as {
        properties: Record<string, unknown>;
        required?: string[];
      };

      for (const field of optionalFields[definition.name] ?? []) {
        expect(schema.required ?? []).not.toContain(field);

        // Rendered as a union with null — `anyOf`, `oneOf` or a type array,
        // depending on the JSON Schema target. Asserted on the serialised
        // shape rather than the keyword, because the keyword is Zod's choice
        // and the provider only cares that null is permitted.
        expect(JSON.stringify(schema.properties[field]), field).toContain('"null"');
      }
    });
  }
});
