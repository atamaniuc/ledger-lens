"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/platform/supabase/browser-client";

// The sign-out affordance. It clears the session through the browser client
// (the proxy owns the cookie) and returns to the login page. Disabled while
// signing out so a double-click cannot race two sign-out calls.

export function LogoutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="logout"
      onClick={async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
