.PHONY: adr prd design worktree worktree-done codex-architect codex-critic codex-review check deno-check

# Usage: make adr TITLE="cursor-based ingestion resume"
adr:
	@test -n "$(TITLE)" || (echo "TITLE required" >&2; exit 1)
	@scripts/harness/new-adr.sh "$(TITLE)"

# Usage: make prd FEATURE="Ingestion cursor resume"
prd:
	@test -n "$(FEATURE)" || (echo "FEATURE required" >&2; exit 1)
	@scripts/harness/new-prd-section.sh "$(FEATURE)"

# Usage: make design FEATURE="Ingestion cursor resume"
design:
	@test -n "$(FEATURE)" || (echo "FEATURE required" >&2; exit 1)
	@scripts/harness/new-design-section.sh "$(FEATURE)"

# Usage: make worktree BRANCH=stage-3-reconciliation [BASE=main]
worktree:
	@test -n "$(BRANCH)" || (echo "BRANCH required" >&2; exit 1)
	@scripts/harness/new-worktree.sh "$(BRANCH)" "$(BASE)"

# Usage: make worktree-done BRANCH=stage-3-reconciliation
worktree-done:
	@test -n "$(BRANCH)" || (echo "BRANCH required" >&2; exit 1)
	@scripts/harness/finish-worktree.sh "$(BRANCH)"

# Usage: make codex-architect PROMPT_FILE=.claude/DESIGN.md
codex-architect:
	@test -n "$(PROMPT_FILE)" || (echo "PROMPT_FILE required" >&2; exit 1)
	@scripts/harness/ask-codex.sh architect "$(PROMPT_FILE)"

# Usage: make codex-critic PROMPT_FILE=.claude/DESIGN.md
codex-critic:
	@test -n "$(PROMPT_FILE)" || (echo "PROMPT_FILE required" >&2; exit 1)
	@scripts/harness/ask-codex.sh critic "$(PROMPT_FILE)"

# Usage: make codex-review [REF=main]
codex-review:
	@scripts/harness/codex-review.sh $(REF)

# The Definition of Done's "tests pass" gate, in one command.
check:
	bun run typecheck
	bun run lint
	bun test
	@$(MAKE) --no-print-directory deno-check

# supabase/functions/ is excluded from tsconfig.json and eslint (Deno
# runtime: npm: specifiers, Deno globals, .ts import extensions), so
# `bun run typecheck` does not cover it. This is the compensating gate —
# without it those files would be checked by nothing at all.
deno-check:
	@if command -v deno >/dev/null 2>&1; then \
		deno check --allow-import supabase/functions/provider-webhook/index.ts; \
	else \
		echo "deno not installed — supabase/functions/ went unchecked. Install Deno to close this gap: https://deno.land"; \
	fi
