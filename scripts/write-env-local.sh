#!/usr/bin/env bash
set -euo pipefail

# Writes .env.local from the running local Supabase stack.
#
# The service-role key is regenerated per machine, so the file cannot be
# committed and hand-copying it from `supabase status` is where a stale key
# comes from. Refuses to overwrite: .env.local may hold values that did not
# come from the stack.

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  echo ".env.local already exists — delete it first if you want it regenerated." >&2
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found — see docs/LOCAL_DEV.md" >&2
  exit 1
fi

# `-o env` gives KEY="value" lines, so no JSON parser is needed and this
# script depends on nothing but the CLI itself.
status="$(supabase status -o env 2>/dev/null)" || {
  echo "the local stack is not running — start it with 'task dev-up'" >&2
  exit 1
}

value_of() {
  printf '%s\n' "$status" | sed -n "s/^$1=\"\(.*\)\"$/\1/p" | head -1
}

api_url="$(value_of API_URL)"
service_key="$(value_of SERVICE_ROLE_KEY)"
anon_key="$(value_of ANON_KEY)"

if [ -z "$api_url" ] || [ -z "$service_key" ] || [ -z "$anon_key" ]; then
  echo "could not read API_URL/SERVICE_ROLE_KEY/ANON_KEY from 'supabase status -o env'" >&2
  exit 1
fi

# Must match supabase/.env, which is what reaches the Edge Function through
# config.toml's [edge_runtime.secrets]. The webhook spec sends the value from
# here and the function checks the value from there.
# Everything after the first '=', not up to the second: '=' is ordinary in
# a base64 secret, and a truncated one fails later as a 401 that points at
# the wrong half of the setup.
webhook_secret="$(sed -n 's/^WEBHOOK_SHARED_SECRET=//p' supabase/.env 2>/dev/null | head -1 || true)"
webhook_secret="${webhook_secret:-local-dev-webhook-secret}"

# Same two-copies rule for the embed function (Stage 5, ADR 0008): it is the
# only path to a vector in this system, so it checks a secret too.
embed_secret="$(sed -n 's/^EMBED_SHARED_SECRET=//p' supabase/.env 2>/dev/null | head -1 || true)"
embed_secret="${embed_secret:-local-dev-embed-secret}"

cat > .env.local <<ENV
# Local development only. Gitignored. Regenerate with 'task env' after
# deleting this file; see docs/LOCAL_DEV.md for what each value is for.
#
# These keys belong to the local Supabase stack. They are fixed development
# values that grant nothing outside this machine — the hosted project's keys
# are real secrets and must never be written into a tracked file.

SUPABASE_URL=$api_url
SUPABASE_SERVICE_ROLE_KEY=$service_key

# Stage 4 (Dashboard). The browser reaches Supabase over the published port;
# the server, when it runs inside the dev container, reaches it over the
# compose network as http://kong:8000 (compose.yaml overrides SUPABASE_URL
# for that). NEXT_PUBLIC_SUPABASE_URL is never overridden — it is baked into
# the client bundle and has to work from outside every container.
#
# The anon key is public by design: RLS is what protects the data, and this
# key only ever reaches Postgres as the `authenticated` (or `anon`) role.
NEXT_PUBLIC_SUPABASE_URL=$api_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon_key

# Shared secrets the two ingestion entry points require. Both entry points
# reject every request when their secret is unset, so these have to exist
# for anything to be testable.
INGESTION_TRIGGER_SECRET=local-dev-ingestion-secret
WEBHOOK_SHARED_SECRET=$webhook_secret

# Stage 5 (RAG): the embed Edge Function's secret. Must match supabase/.env.
EMBED_SHARED_SECRET=$embed_secret

# Mock provider: seeded PRNG, all seven chaos flags on by default. Leave them
# on — the failure modes are the regression tests. Override per request
# instead (?rateLimit=false).
MOCK_PROVIDER_SEED=42
ENV

echo "wrote .env.local"
