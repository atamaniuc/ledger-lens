// Runtime copilot settings (D-53): guards flag, demo mode, and providers
// configured at runtime instead of only from the environment.
//
// The row is a global singleton read through SECURITY DEFINER functions, so
// no Data API grant touches the table. The admin page writes it; the chat
// route reads it and decides how to behave.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";

/** A provider the operator added at runtime. The key itself never touches the
 * database: `keyName` is the environment variable that holds it at call time. */
export interface RuntimeProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyName: string;
  enabled: boolean;
}

export interface CopilotSettings {
  guardsEnabled: boolean;
  demoMode: boolean;
  providers: RuntimeProvider[];
  updatedAt?: string | null;
}

interface SettingsRpc {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

function parseSettings(raw: unknown): CopilotSettings {
  const value = raw as
    | {
        guards_enabled?: boolean;
        demo_mode?: boolean;
        providers?: unknown;
        updated_at?: string | null;
      }
    | null
    | undefined;
  if (!value || typeof value !== "object") {
    throw new Error("get_copilot_settings returned an unexpected shape");
  }
  const providers = Array.isArray(value.providers) ? (value.providers as RuntimeProvider[]) : [];
  return {
    guardsEnabled: value.guards_enabled ?? true,
    demoMode: value.demo_mode ?? false,
    providers,
    updatedAt: value.updated_at ?? null,
  };
}

export async function getCopilotSettings(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<CopilotSettings> {
  const { data, error } = await (supabase as unknown as SettingsRpc).rpc("get_copilot_settings", {
    p_org_id: orgId,
  });
  if (error) throw new Error(`get_copilot_settings failed: ${error.message}`);
  return parseSettings(data);
}

export async function updateCopilotSettings(
  supabase: SupabaseClient<Database>,
  orgId: string,
  patch: { guardsEnabled: boolean; demoMode: boolean; providers: RuntimeProvider[] },
): Promise<void> {
  const { error } = await (supabase as unknown as SettingsRpc).rpc("update_copilot_settings", {
    p_org_id: orgId,
    p_guards: patch.guardsEnabled,
    p_demo_mode: patch.demoMode,
    p_providers: JSON.stringify(patch.providers),
  });
  if (error) throw new Error(`update_copilot_settings failed: ${error.message}`);
}
