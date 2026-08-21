#!/usr/bin/env bash
# Plan the whole deploy program with no credentials and no Pulumi Cloud.
#
# `task check-infra` asserts the program through pulumi.runtime.setMocks, which
# proves the shape of what it builds. This proves something the mocks cannot:
# that the real engine loads the program, resolves the providers, computes every
# output and plans every resource. It does that against a throwaway file backend
# and placeholder config, so it needs nothing anyone owns.
#
# The one value that must look real is the Vercel token: the provider validates
# its shape (24 lowercase hex characters) before any API call, so the
# placeholder below is shaped like a token and is not one. Nothing here reaches
# Vercel — a preview of creates makes no API call.
#
# Usage: task infra-plan
set -euo pipefail

cd "$(dirname "$0")/.."

# Plugins land inside the repo rather than ~/.pulumi so a sandboxed shell can
# write them; both paths are gitignored.
export PULUMI_HOME="${PULUMI_HOME:-$PWD/../.pulumi-home}"
export PULUMI_BACKEND_URL="file://${TMPDIR:-/tmp}/ledgerlens-infra-plan"
export PULUMI_CONFIG_PASSPHRASE="plan-only"
mkdir -p "$PULUMI_HOME" "${TMPDIR:-/tmp}/ledgerlens-infra-plan"

STACK=plan
pulumi stack select "$STACK" --non-interactive >/dev/null 2>&1 ||
  pulumi stack init "$STACK" --non-interactive >/dev/null

pulumi config set supabaseProjectRef plan-project-ref --stack "$STACK" >/dev/null
pulumi config set supabaseAnonKey plan-anon-key --stack "$STACK" >/dev/null
# Shaped like a Vercel token, and deliberately not one.
pulumi config set --secret vercelApiToken 0123456789abcdef01234567 --stack "$STACK" >/dev/null
for key in supabaseAccessToken dbPassword supabaseServiceRoleKey \
  ingestionTriggerSecret webhookSharedSecret embedSharedSecret; do
  pulumi config set --secret "$key" plan-placeholder --stack "$STACK" >/dev/null
done

echo "planning against a local backend — no credentials, nothing is created"
pulumi preview --stack "$STACK" --non-interactive
