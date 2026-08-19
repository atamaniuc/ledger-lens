import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server-client";

// The root has nothing of its own to show: signed in, the dashboard is the
// product; signed out, the only available action is to sign in.
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}
