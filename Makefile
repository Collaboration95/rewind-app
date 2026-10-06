.PHONY: run run-real issues

# Real sign-in needs HTTPS or loopback, so both targets use the localhost proxy.
run: run-real

run-real:
	node scripts/run-real-local.mjs

issues:
	@scripts/issues.sh
