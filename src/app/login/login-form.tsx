"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/platform/supabase/browser-client";

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

    // shouldCreateUser: false because sign-up is closed (D-20): an operator
    // creates accounts, so an unknown address is told plainly instead of
    // quietly becoming a user who belongs to no organisation.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callback.toString(), shouldCreateUser: false },
    });

    setState(
      error ? { kind: "failed", message: error.message } : { kind: "sent", email },
    );
  }

  if (state.kind === "sent") {
    return (
      <p role="status" data-testid="login-sent" className="text-sm text-muted-foreground">
        Check <strong className="text-foreground">{state.email}</strong> for a
        sign-in link. Locally, mail goes to Mailpit on port 54324 rather than to
        a real inbox.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-tight">
      <label htmlFor="email" className="text-xs text-muted-foreground">
        Work email
      </label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        disabled={state.kind === "sending"}
      />
      <Button type="submit" disabled={state.kind === "sending"} className="mt-tight">
        {state.kind === "sending" ? "Sending…" : "Send sign-in link"}
      </Button>
      {state.kind === "failed" && (
        <p
          role="alert"
          data-testid="login-error"
          className="text-sm text-destructive"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
