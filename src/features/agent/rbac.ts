// D-08: the RBAC gate for write-adjacent tools.
//
// memberships.role is admin | member | viewer and nothing checked it. The
// rule this module enforces is the least surprising one: a viewer may read
// but may not invoke a write-adjacent tool (draft_customer_email); member
// and admin may. The check itself lives in Postgres (migration
// 20260821100000, function assert_can_draft_tool) and stamps auth.uid()
// itself, so the caller's own JWT decides and nobody can name someone
// else's membership — this module is how the tool registry reaches it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";

export class RbacRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RbacRefusedError";
  }
}

// The generated Database types do not know the gate RPC yet (they are
// regenerated from the schema at integration). Narrow, locally typed channel
// — same pattern as the budget RPC in ./budget.ts.
interface GateRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * Refuses when the caller's own membership in orgId is role 'viewer'.
 * Resolves normally for member and admin. Called before every draft-effect
 * tool executes; a refusal surfaces as an error the loop reports back to
 * the model and writes to audit_log, so the attempt is visible either way.
 */
export async function assertCanDraft(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<void> {
  const { data, error } = await (supabase as unknown as GateRpc).rpc("assert_can_draft_tool", {
    p_org_id: orgId,
  });
  void data;
  if (error) throw new RbacRefusedError(error.message);
}
