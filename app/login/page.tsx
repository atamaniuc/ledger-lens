import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server-client";
import { LoginForm } from "./login-form";

// Not covered by proxy.ts's matcher, so an already-signed-in visitor would
// otherwise sit on a login form they no longer need.
//
// searchParams is typed here rather than through Next's generated
// `PageProps<"/login">`: that helper only exists once a build has emitted
// route types, so relying on it makes `task typecheck` order-dependent on a
// build having run first.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(readOne(params.next));
  const error = readOne(params.error);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(next);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-page">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sign in to LedgerLens</CardTitle>
          <CardDescription>
            A link, not a password — credential handling stays out of this
            codebase.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-gutter">
          {error && (
            <p
              role="alert"
              data-testid="callback-error"
              className="text-sm text-destructive"
            >
              {CALLBACK_ERRORS[error] ?? CALLBACK_ERRORS.invalid}
            </p>
          )}
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}

// Every string a visitor can put on this page, and no others — the callback
// sends a code, never a message. An unrecognised code falls through to
// `invalid` rather than rendering itself.
const CALLBACK_ERRORS: Record<string, string> = {
  expired: "That sign-in link has expired. Request a new one below.",
  used: "That sign-in link has already been used. Request a new one below.",
  missing: "That link was incomplete. Request a new one below.",
  invalid: "That sign-in link did not work. Request a new one below.",
};

// A repeated query parameter arrives as an array. Taking the first is the
// same thing the URL would mean to a person reading it.
function readOne(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
