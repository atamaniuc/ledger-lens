import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getCopilotSettings,
  updateCopilotSettings,
  type RuntimeProvider,
} from "@/features/admin/copilot-settings";
import { createClient } from "@/platform/supabase/server-client";

// The admin endpoint for runtime copilot settings (D-53): the guards flag,
// demo mode, and OpenAI-compatible providers configured without a redeploy.
//
// Reads are allowed for any member of the org (the SECURITY DEFINER RPC
// checks membership); writes require the admin role (the update RPC raises
// otherwise, surfaced here as 403).

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(120),
  keyName: z
    .string()
    .min(1)
    .max(120)
    // An env var name: uppercase letters, digits, underscores only.
    .regex(/^[A-Z][A-Z0-9_]*$/),
  enabled: z.boolean(),
});

const patchSchema = z.object({
  guardsEnabled: z.boolean(),
  demoMode: z.boolean(),
  providers: z.array(providerSchema).max(10),
});

/** Which key env vars exist on this instance, so the UI can show them. */
function keySet(providers: RuntimeProvider[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const provider of providers) out[provider.keyName] = process.env[provider.keyName] !== undefined;
  return out;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: memberships } = await supabase.from("memberships").select("org_id").limit(1);
  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: "no organization for this user" }, { status: 403 });
  }
  const orgId = memberships[0].org_id;

  try {
    const settings = await getCopilotSettings(supabase, orgId);
    return NextResponse.json({ ...settings, key_set: keySet(settings.providers) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not read settings" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: memberships } = await supabase.from("memberships").select("org_id").limit(1);
  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: "no organization for this user" }, { status: 403 });
  }
  const orgId = memberships[0].org_id;

  let parsed;
  try {
    parsed = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "malformed settings" }, { status: 400 });
  }

  try {
    await updateCopilotSettings(supabase, orgId, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The RPC raises 'only an admin may change copilot settings' with 42501.
    return NextResponse.json({ error: message }, { status: message.includes("admin") ? 403 : 500 });
  }
  return NextResponse.json({ ok: true });
}
