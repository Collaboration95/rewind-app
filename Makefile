.PHONY: run run-demo issues

run:
	npm run dev:lan

run-demo:
	EXPO_PUBLIC_CAMERA_MODE=demo npm run dev:lan

issues:
	@scripts/issues.sh
