"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser-client";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "failed"; message: string };

/**
 * Magic-link sign-in. No password field on purpose: the seeded users have
 * passwords so the RLS tests can sign in over HTTP, but the product's own
 * flow is a link, which keeps credential handling out of this codebase.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    if (!email) return;

    setState({ kind: "sending" });
    const supabase = createClient();
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", next);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callback.toString() },
    });

    setState(
      error ? { kind: "failed", message: error.message } : { kind: "sent", email },
    );
  }

  if (state.kind === "sent") {
    return (
      <p role="status" data-testid="login-sent">
        Check <strong>{state.email}</strong> for a sign-in link. Locally, mail
        goes to Mailpit on port 54324 rather than to a real inbox.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="email">Work email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        disabled={state.kind === "sending"}
      />
      <button type="submit" disabled={state.kind === "sending"}>
        {state.kind === "sending" ? "Sending…" : "Send sign-in link"}
      </button>
      {state.kind === "failed" && (
        <p role="alert" data-testid="login-error">
          {state.message}
        </p>
      )}
    </form>
  );
}
