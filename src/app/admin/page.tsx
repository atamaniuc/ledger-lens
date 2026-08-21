import { redirect } from "next/navigation";
import { createClient } from "@/platform/supabase/server-client";
import { CopilotSettingsForm } from "./copilot-settings-form";
import { AppHeader } from "@/components/app-header";

// The admin page (D-53): guards flag, demo mode, and runtime OpenAI-compatible
// providers — the knobs that let a presentation never show "try again later".
//
// Access: admin role only. The check is the same one the settings RPC
// enforces; this page just renders the gate early instead of on the first
// save.

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("memberships")
    .select("org_id, role")
    .limit(2);
  if (!memberships || memberships.length === 0) redirect("/dashboard");
  if (memberships.length > 1) redirect("/dashboard");
  if (memberships[0].role !== "admin") redirect("/dashboard");

  return (
    <div className="mx-auto w-full max-w-3xl px-page py-page">
      <AppHeader email={user?.email ?? "unknown"} />
      <h1 className="mt-gutter text-xl font-semibold">Copilot settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Runtime knobs for presentations and demos. The guard stays on by
        default; turning it off or enabling demo mode is an operator decision.
      </p>
      <CopilotSettingsForm />
    </div>
  );
}
