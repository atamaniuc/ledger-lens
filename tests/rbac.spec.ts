import { expect, test } from "@playwright/test";
import { ALICE, ORG_A, asUser, sql } from "./helpers/db";

// AC-03 / D-08: a viewer may read but may not invoke the write-adjacent
// tool; member and admin may. The gate is the SECURITY DEFINER function
// assert_can_draft_tool (migration 20260821100000), which stamps
// auth.uid() itself — so these assertions run under the caller's own JWT
// and no argument can name someone else's membership. The tool registry
// calls this exact function before a draft-effect tool executes (proven at
// the registry and loop level by src/features/agent/rbac.test.ts); what
// only the database can show is the refusal under a real role claim.

test.describe("the RBAC gate (D-08)", () => {
  test("a viewer membership cannot pass the draft gate", async () => {
    const viewerId = crypto.randomUUID();
    await sql`insert into memberships (user_id, org_id, role) values (${viewerId}, ${ORG_A}, 'viewer')`;
    try {
      await asUser(viewerId, async (tx) => {
        await expect(
          tx.unsafe(`select public.assert_can_draft_tool('${ORG_A}'::uuid)`),
        ).rejects.toThrow(/viewer role cannot use write-adjacent tools/);
      });
    } finally {
      await sql`delete from memberships where user_id = ${viewerId}`;
    }
  });

  test("a member membership passes the draft gate", async () => {
    const memberId = crypto.randomUUID();
    await sql`insert into memberships (user_id, org_id, role) values (${memberId}, ${ORG_A}, 'member')`;
    try {
      await asUser(memberId, async (tx) => {
        const rows = await tx.unsafe(`select public.assert_can_draft_tool('${ORG_A}'::uuid)`);
        expect(rows.length).toBe(1);
      });
    } finally {
      await sql`delete from memberships where user_id = ${memberId}`;
    }
  });

  test("an admin passes the draft gate — the seeded role", async () => {
    await asUser(ALICE, async (tx) => {
      const rows = await tx.unsafe(`select public.assert_can_draft_tool('${ORG_A}'::uuid)`);
      expect(rows.length).toBe(1);
    });
  });

  test("a valid JWT with no membership is refused rather than assumed safe", async () => {
    await asUser("99999999-9999-4999-8999-999999999999", async (tx) => {
      await expect(
        tx.unsafe(`select public.assert_can_draft_tool('${ORG_A}'::uuid)`),
      ).rejects.toThrow(/not a member/);
    });
  });

  test("a viewer of one org cannot draft through another org either", async () => {
    const viewerId = crypto.randomUUID();
    await sql`insert into memberships (user_id, org_id, role) values (${viewerId}, ${ORG_A}, 'viewer')`;
    try {
      await asUser(viewerId, async (tx) => {
        // Globex is not the viewer's org, so the gate refuses on membership
        // before the role check — never a cross-org grant.
        await expect(
          tx.unsafe("select public.assert_can_draft_tool('00000000-0000-4000-8000-000000000002'::uuid)"),
        ).rejects.toThrow(/not a member/);
      });
    } finally {
      await sql`delete from memberships where user_id = ${viewerId}`;
    }
  });
});
