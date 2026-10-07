.PHONY: run run-real issues review

# Real sign-in needs HTTPS or loopback, so both targets use the localhost proxy.
run: run-real

run-real:
	node scripts/run-real-local.mjs

issues:
	@scripts/issues.sh

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
