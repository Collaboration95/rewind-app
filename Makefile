.PHONY: run run-real issues review postgres-test-db test-postgres

# Real sign-in needs HTTPS or loopback, so both targets use the localhost proxy.
run: run-real

run-real:
	node scripts/run-real-local.mjs

issues:
	@scripts/issues.sh

# Local PostgreSQL 17 for `make test-postgres` (disposable: RAM-backed, no fsync).
postgres-test-db:
	docker start rewind-pg-dev 2>/dev/null || docker run -d --name rewind-pg-dev \
	  --tmpfs /var/lib/postgresql/data:rw,size=3g -e POSTGRES_PASSWORD=devpass \
	  -p 127.0.0.1:55432:5432 postgres:17-alpine -c fsync=off -c synchronous_commit=off \
	  -c full_page_writes=off -c max_connections=300

# The server suite on PostgreSQL (#261); each run uses its own throwaway database.
test-postgres: postgres-test-db
	npm run server:test:postgres

# The one review-agent pass, run from the PR head's worktree. Default: GPT-6 Luna,
# high effort, fast tier. Sensitive work: make review MODEL=gpt-6.1-sol [EFFORT=medium].
# </dev/null: without it codex exec waits on stdin and hangs.
review:
	git fetch -q origin dev
ifdef MODEL
	codex exec review --base origin/dev -m $(MODEL) -c model_reasoning_effort="$(or $(EFFORT),medium)" </dev/null
else
	codex exec review --base origin/dev -m gpt-6-luna -c model_reasoning_effort="high" -c service_tier="fast" --enable fast_mode </dev/null
endif
