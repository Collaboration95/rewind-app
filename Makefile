.PHONY: run run-demo run-real issues

run:
	npm run dev:lan

run-demo:
	EXPO_PUBLIC_CAMERA_MODE=demo npm run dev:lan

run-real:
	node scripts/run-real-local.mjs

issues:
	@scripts/issues.sh
