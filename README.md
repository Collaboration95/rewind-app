# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
through a group cycle, then experiencing them together after a delayed reveal.

The included Demo uses synthetic data. It is not authentication, a secure
account, public hosting, or a cloud media service.

## Start the app

Use the Node.js 22 version in `.nvmrc` (22.23.3), npm 10 or newer, and a
current Chromium-based browser for the Expo web demo. With nvm, run
`nvm use` before `npm ci`; the CI workflow reads the same version file.

```sh
npm ci
npm run check
npm run web
```

Open the Expo URL printed in the terminal (normally `http://localhost:8081`).
This offline Demo needs no AWS credentials, account, private media, or deployed
service.

For a reproducible UI review, use the explicitly labelled fixture camera:

```sh
EXPO_PUBLIC_CAMERA_MODE=demo npm run web
```

Use `EXPO_PUBLIC_CAMERA_MODE=demo-denied` to review the denied-permission
state. Leave it unset for the native camera boundary; real capture and clip
upload require a physical device and the optional local runtime. Set
`EXPO_PUBLIC_DEMO_ACCESS=entry` to start at the Demo member chooser instead of
the default synthetic Amber session.

## Optional local runtime

The companion Node service adds local SQLite persistence, media processing,
and the full capsule flow. It is intended for a trusted development machine or
LAN only; it is not a hosted service.

```sh
npm run server:preflight  # validate SQLite, LAN binding, and FFmpeg
npm run server:start      # build and run the local service
npm run server:reset      # restore the deterministic five-member fixture
```

Point an iOS simulator at localhost, or a physical device at your trusted LAN
address, before starting Expo:

```sh
EXPO_PUBLIC_LOCAL_BASE_URL=http://127.0.0.1:8787 npm start -- --ios --lan --clear
```

When this variable is absent, the app remains on the offline synthetic Demo.
If the runtime is unavailable, the app keeps an explicit retryable state rather
than claiming the service is connected.

The HTTP boundary has bounded defaults in both local CLI and Compose runtime
modes: 30 seconds of request-body idle time, 120 seconds per media upload, two
concurrent media intakes, and one concurrent media processor. Override them
with `REWIND_HTTP_IDLE_TIMEOUT_MS`, `REWIND_HTTP_UPLOAD_TIMEOUT_MS`,
`REWIND_HTTP_MAX_CONCURRENT_INTAKES`, and
`REWIND_HTTP_MAX_CONCURRENT_PROCESSING` when a trusted runtime needs different
bounds. JSON bodies remain capped at 64 KiB and staged media at 50 MiB.
Slow or aborted bodies use a deterministic 408 response when the connection
is still writable, oversized bodies use 413, and capacity rejections use 429;
there is no distributed rate limiter.

## Current scope and limits

- The Demo has five synthetic members and local-only session state.
- Real capture requires a physical device. The fixture camera is clearly
  labelled and does not claim to capture a physical image.
- Group media stays on the local runtime. Do not use real or sensitive media.
- The hosted-Demo persistence and recovery procedure is separate from this
  local quick start; follow the guarded deployment guide before operating it.

## Checks

```sh
npm run check             # format, lint, architecture, types, and tests
npm run test:responsive   # web layout checks at supported viewports
npm run server:preflight  # local runtime, SQLite, LAN, and FFmpeg readiness
```

## Further reading

- [Local-first boundary](docs/architecture/ADR-0001-local-first-sprint-0.md)
- [Camera capture boundary](docs/architecture/ADR-0002-camera-capture-boundary.md)
- [Domain contracts](docs/domain/contracts.md)
- [Local Demo runbook](docs/local-demo-runbook.md)
- [Hosted Demo persistence](docs/architecture/hosted-demo-persistence.md)
- [Hosted deployment, backup, and recovery](deploy/README.md)
- [Current Sprint plan](doc/planning/sprints/sprint-2-plan.md)
