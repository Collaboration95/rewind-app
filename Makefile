.PHONY: run run-real issues

run:
	npm run dev:lan

run-real:
	node scripts/run-real-local.mjs

issues:
	@scripts/issues.sh
