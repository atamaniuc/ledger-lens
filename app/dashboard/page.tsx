import { createClient } from "@/lib/supabase/server-client";

// Placeholder. T17 replaces this with the assembled dashboard; it exists now
// so the access foundation has something real to protect and the redirect,
// the session refresh and the RLS read path are all testable before any
// panel exists.
export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Reads under the user's own JWT, so this returns the caller's orgs and
  // nobody else's without a single org_id filter in this file — ADR 0007.
  const { data: orgs, error } = await supabase
    .from("orgs")
    .select("id, name")
    .order("name");

  return (
    <main>
      <h1>Dashboard</h1>
      <p data-testid="signed-in-as">{user?.email}</p>
      {error ? (
        <p role="alert" data-testid="orgs-error">
          {error.message}
        </p>
      ) : (
        <ul data-testid="orgs">
          {orgs?.map((org) => <li key={org.id}>{org.name}</li>)}
        </ul>
      )}
    </main>
  );
}
