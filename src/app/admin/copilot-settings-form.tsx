"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";

// The client half of the admin page. Loads the current settings, edits them
// in local state, and saves the whole patch. Providers are OpenAI-compatible
// endpoints whose API key is named by an environment variable — the key
// itself never enters the database or the browser.

interface RuntimeProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyName: string;
  enabled: boolean;
}

interface Settings {
  guardsEnabled: boolean;
  demoMode: boolean;
  providers: RuntimeProvider[];
  key_set?: Record<string, boolean>;
}

const newProvider = (): RuntimeProvider => ({
  id: crypto.randomUUID(),
  name: "",
  baseUrl: "",
  model: "",
  keyName: "OPENAI_API_KEY",
  enabled: true,
});

export function CopilotSettingsForm() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/admin/copilot-settings")
      .then(async (res) => {
        if (!res.ok) throw new Error("could not load settings");
        return res.json() as Promise<Settings>;
      })
      .then(setSettings)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-sm text-status-fail">{error}</p>;
  if (!settings) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const patchProvider = (id: string, field: Partial<RuntimeProvider>) =>
    setSettings({
      ...settings,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...field } : p)),
    });

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/admin/copilot-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guardsEnabled: settings.guardsEnabled,
          demoMode: settings.demoMode,
          providers: settings.providers,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "save failed");
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-control bg-surface-sunken p-4">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            <span className="font-medium">Guards</span>
            <span className="block text-xs text-muted-foreground">
              Off means the copilot never returns 429/402 — for presentations
              and stress tests. Default on.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.guardsEnabled}
            onChange={(e) => setSettings({ ...settings, guardsEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            <span className="font-medium">Demo mode</span>
            <span className="block text-xs text-muted-foreground">
              On means the copilot always answers from this tenant&apos;s real
              data — deterministically, with no model call — even when every
              provider is spent. Answers are marked &quot;Demo answer&quot;.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.demoMode}
            onChange={(e) => setSettings({ ...settings, demoMode: e.target.checked })}
          />
        </label>
      </div>

      <div>
        <h2 className="text-sm font-semibold">Runtime providers</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenAI-compatible endpoints, joined to the failover chain after the
          environment-configured ones. The API key is read from the named
          environment variable at call time — it never touches the database.
        </p>

        <div className="mt-3 flex flex-col gap-3">
          {settings.providers.map((provider) => (
            <div key={provider.id} className="rounded-control bg-surface-sunken p-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={provider.name}
                  placeholder="Name"
                  onChange={(e) => patchProvider(provider.id, { name: e.target.value })}
                />
                <Input
                  value={provider.model}
                  placeholder="Model id"
                  onChange={(e) => patchProvider(provider.id, { model: e.target.value })}
                />
                <Input
                  value={provider.baseUrl}
                  placeholder="Base URL"
                  onChange={(e) => patchProvider(provider.id, { baseUrl: e.target.value })}
                />
                <Input
                  value={provider.keyName}
                  placeholder="Env var with the API key"
                  onChange={(e) => patchProvider(provider.id, { keyName: e.target.value })}
                />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    onChange={(e) => patchProvider(provider.id, { enabled: e.target.checked })}
                  />
                  enabled
                </label>
                <span className="text-xs text-faint">
                  {settings.key_set?.[provider.keyName] ? "key present" : "key env not set"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSettings({
                      ...settings,
                      providers: settings.providers.filter((p) => p.id !== provider.id),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Button
          className="mt-3"
          variant="outline"
          onClick={() =>
            setSettings({ ...settings, providers: [...settings.providers, newProvider()] })
          }
        >
          Add provider
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && <span className="text-xs text-status-pass">Saved.</span>}
        {error && <span className="text-xs text-status-fail">{error}</span>}
      </div>
    </div>
  );
}
