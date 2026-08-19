import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { TOOLS, runTool } from "../lib/agent/tools";
import type { CustomerEmailDraft } from "../lib/agent/tools";
import type { Database } from "../lib/supabase/database.types";
import { ingest } from "./helpers/api";
import { ORG_A, ORG_B, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 5, Batch G: the four tools against a real database, as real users.
//
// The unit tests prove the registry is four tools and that a model's
// arguments are validated before they reach a query. This proves the thing
// those cannot: that a tool called by the wrong tenant returns nothing,
// because every one of them executes with the caller's own JWT and no tool
// takes an org_id (ADR 0009, US-03).

let apiUrl: string;
let anonKey: string;
let acmeInvoice: string;

async function clientFor(email: string): Promise<SupabaseClient<Database>> {
  const supabase = createClient<Database>(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return supabase;
}

const contextFor = async (email: string, orgId: string) => ({
  supabase: await clientFor(email),
  orgId,
  correlationId: `tools-spec-${Date.now()}`,
});

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  ({ apiUrl, anonKey } = localStack());

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from invoices where org_id = ${ORG_A}`;
  if (count === 0) await ingest(request, ORG_A);

  // `search_documents` needs an index; earlier specs truncate it away.
  execFileSync("bun", ["run", "scripts/index-corpus.ts"], { stdio: "ignore" });

  const [row] = await sql<{ external_id: string }[]>`
    select external_id from invoices where org_id = ${ORG_A} order by external_id limit 1`;
  acmeInvoice = row.external_id;
});

test.describe("Stage 5 — the four tools", () => {
  test("a member gets their own org's figures", async () => {
    const context = await contextFor("alice@acme.test", ORG_A);

    const summary = (await runTool(context, "get_revenue_summary", {})) as {
      invoice_count: number;
      total_cents: number | null;
    };

    expect(summary.invoice_count).toBeGreaterThan(0);
    expect(summary.total_cents).toBeGreaterThan(0);
  });

  test("get_revenue_summary honours its filters", async () => {
    const context = await contextFor("alice@acme.test", ORG_A);

    const all = (await runTool(context, "get_revenue_summary", {})) as { invoice_count: number };
    const paid = (await runTool(context, "get_revenue_summary", { status: "paid" })) as {
      invoice_count: number;
    };

    expect(paid.invoice_count).toBeLessThanOrEqual(all.invoice_count);
  });

  test("list_invoices caps its own result set and says when it truncated", async () => {
    const context = await contextFor("alice@acme.test", ORG_A);

    const page = (await runTool(context, "list_invoices", { limit: 3 })) as {
      invoices: unknown[];
      truncated: boolean;
    };

    expect(page.invoices).toHaveLength(3);
    expect(page.truncated).toBe(true);
  });

  test("search_documents returns the caller's own corpus", async () => {
    const context = await contextFor("alice@acme.test", ORG_A);

    const result = (await runTool(context, "search_documents", {
      query: "what is our early settlement discount?",
    })) as { chunks: { document_title: string | null }[] };

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.map((c) => c.document_title)).toContain("Acme standard payment terms");
  });

  test("draft_customer_email composes a draft and sends nothing", async () => {
    const context = await contextFor("alice@acme.test", ORG_A);

    const draft = (await runTool(context, "draft_customer_email", {
      external_id: acmeInvoice,
      purpose: "payment_reminder",
    })) as CustomerEmailDraft;

    expect(draft.delivery).toBe("not_sent");
    expect(draft.subject).toContain(acmeInvoice);
    expect(draft.body).toContain(draft.invoice.customer);
    // The figures come from the database, not from the conversation.
    expect(draft.body).toContain(draft.invoice.amount);
  });

  test("a Globex user reaches nothing of Acme's through any tool", async () => {
    // Both tenants ingest the same mock-provider dataset, so an `external_id`
    // legitimately exists in both — that is Stage 2's tenant-scoped
    // idempotency working, not a leak. Which means identifiers prove nothing
    // here and row ids do: the same call with a different JWT has to come
    // back with the *other tenant's* row, never Acme's.
    const context = await contextFor("bob@globex.test", ORG_B);

    const [acmeRow] = await sql<{ id: string }[]>`
      select id from invoices where org_id = ${ORG_A} and external_id = ${acmeInvoice}`;

    const byId = (await runTool(context, "list_invoices", { external_id: acmeInvoice })) as {
      invoices: { invoice_id: string }[];
    };
    expect(byId.invoices.map((invoice) => invoice.invoice_id)).not.toContain(acmeRow.id);
    for (const invoice of byId.invoices) {
      const [{ org_id }] = await sql<{ org_id: string }[]>`
        select org_id from invoices where id = ${invoice.invoice_id}`;
      expect(org_id).toBe(ORG_B);
    }

    // The document corpus is where the two tenants genuinely differ, so it is
    // where a leak would show as a wrong answer rather than a wrong id.
    const search = (await runTool(context, "search_documents", {
      query: "Acme early settlement discount and collections",
      limit: 8,
    })) as { chunks: { document_title: string | null; chunk_id: number }[] };
    for (const chunk of search.chunks) {
      expect(chunk.document_title).not.toBe("Acme standard payment terms");
      const [{ org_id }] = await sql<{ org_id: string }[]>`
        select org_id from chunks where id = ${chunk.chunk_id}`;
      expect(org_id).toBe(ORG_B);
    }

    // The draft tool composes from a row, so it inherits the same boundary:
    // asked about an identifier both tenants hold, it drafts from Globex's.
    const draft = (await runTool(context, "draft_customer_email", {
      external_id: acmeInvoice,
      purpose: "payment_reminder",
    })) as CustomerEmailDraft;
    expect(draft.invoice.invoice_id).not.toBe(acmeRow.id);

    const summary = (await runTool(context, "get_revenue_summary", {})) as {
      total_cents: number | null;
    };
    const [{ total }] = await sql<{ total: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as total from invoices where org_id = ${ORG_B}`;
    expect(summary.total_cents).toBe(total);
  });

  test("an invoice no tenant of the caller's holds is refused, not described", async () => {
    // Not-found and not-visible are the same answer on purpose: telling them
    // apart would confirm another tenant's invoice exists.
    const context = await contextFor("bob@globex.test", ORG_B);
    await expect(
      runTool(context, "draft_customer_email", {
        external_id: "inv_does_not_exist_anywhere",
        purpose: "payment_reminder",
      }),
    ).rejects.toThrow(/visible/);
  });

  test("no tool in the registry can write anything", async () => {
    // Belt to the unit test's braces, asserted against the running database:
    // a read-only grant means even a tool that tried would be refused.
    const context = await contextFor("alice@acme.test", ORG_A);
    expect(TOOLS.every((tool) => tool.effect === "read" || tool.effect === "draft")).toBe(true);

    const { error } = await context.supabase
      .from("invoices")
      .update({ customer: "rewritten" })
      .eq("external_id", acmeInvoice);
    expect(error, "authenticated must not be able to update invoices").not.toBeNull();
  });
});
