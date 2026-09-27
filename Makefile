.PHONY: run run-demo

run:
	npm run dev:lan

run-demo:
	EXPO_PUBLIC_CAMERA_MODE=demo npm run dev:lan
