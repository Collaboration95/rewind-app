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

## Security checks with Vigolium

Vigolium 0.5.1 is pinned as a development dependency and installed by `npm ci`.
Run `npm run security:doctor` to inspect machine readiness. On a new machine,
run `npx --no-install vigolium init` to initialize its user configuration and
scanner data. Configuration and provider credentials stay in `~/.vigolium/`;
do not commit credentials or raw scan results.

Start the local runtime in one terminal (`npm run server:start`), then scan
its health endpoint from another:

```sh
npm run security:scan -- -t http://127.0.0.1:8787/health
```

For the Expo web app, start `npm run web`, then use the URL printed by Expo:

```sh
npm run security:scan -- -t http://127.0.0.1:8081
```

This command runs passive HTTP checks on the supplied URLs, caps requests at
five per second and scan duration at five minutes, and avoids browser crawling.
It does not discover or audit every application route. Supply additional `-t`
arguments for the endpoints you want checked. Scan disposable test data on
systems you are authorized to assess. The HTML report is written to
`vigolium-result/http-report.html` from the project-local database at `vigolium-result/http.sqlite`.
Run `npm run security:report` to regenerate the report from accumulated scan data.

For a source-code audit of this repository:

```sh
npm run security:audit
```

The audit uses Vigolium's embedded audit driver and requires an authenticated
Codex CLI on PATH. It can invoke coding-agent tools and consume model usage;
run it explicitly when needed. Reports go to `vigolium-result/source-audit/`
and raw audit artifacts to `vigolium-results/`; both are ignored by Git.
The `Vigolium security scan` GitHub Actions workflow runs automatically on
pushes and pull requests to `dev`, and can also be started manually from
Actions. It starts a disposable loopback backend and passively checks `/health`,
`/profiles`, `/auth/session`, and `/real/groups` without signing in. It then
creates disposable owner, joined-member and outsider accounts, checks group and
chat access, scans six owner and six member routes plus three outsider routes,
and checks their expected access statuses.
Each identity uses a separate scan database. Download the
`vigolium-report` artifact from the workflow run and start with `summary.html`
in the `automatic` folder for commit/time metadata, expected versus actual access results, finding evidence,
interpretation, next steps, and coverage limitations. The summary is generated
automatically from scanner exports. Expand a finding to inspect matched source
snippets with file/line references, an explanation of the behavior, suggested
configuration or code changes, and validation steps. Suggestions are not applied
automatically. Source correlation is currently provided for the CORS and API
version modules; other modules explicitly report when no correlation is available.
Open `report.html`,
`owner.html`, `member.html`, or `outsider.html` to view
results. Reports are retained for 14 days. Findings are advisory; scanner or
startup errors fail the workflow, but findings do not currently block merging.
The workflow also runs bounded active checks on a separate disposable backend.
It does not run the AI source audit, browser crawling, or media upload/reveal journeys. Local HTTP authentication is enabled only in
the disposable loopback runtime; credentials are generated per run and redacted
from exported reports.

Run the same automatic scan locally with `npm run security:auto`. Its reports
are in `vigolium-result/automatic/`, and its database and runtime data are
temporary. No running or hosted Rewind instance is targeted.

These checks are not part of the aggregate Quality gate.
Review findings manually: a completed scan is not proof that the app is secure.

### Bounded active DAST

Run `npm run security:active` for SQL error-based and boolean-based checks on
three group JSON fields (`name`, `prompt`, `maxMembers`) and authenticated chat
message input (`body`). It creates a disposable local account and database,
verifies successful baselines, and selects only `sqli-error-based` and
`sqli-boolean-blind`. The dev workflow runs this command after the passive scan.

A loopback proxy allows only the two selected POST endpoints and paces requests
below two per second. Each scanner process has a four-minute deadline. The runner
records request counts, changed bodies and response statuses per endpoint, and
fails if either endpoint receives no body mutations. Module selection does not
prove every technique performed mutations; the report states this limitation.

It generates `vigolium-result/active/summary.html`, `report.html`, `report.jsonl`,
and `scope.json`, redacts temporary credentials, and removes temporary runtime
data. Valid mutated requests may create groups and messages in that temporary database.

This is a bounded assessment. It does not cover time-based injection, XSS,
browser/media journeys, source auditing or the hosted app. A zero-finding result
only describes these checks. CORS and version disclosure remain advisory and
require a product decision; source suggestions are never applied automatically.

## Optional local runtime

The companion Node service adds local SQLite persistence, media processing,
and the full capsule flow. It is intended for a trusted development machine or
LAN only; it is not a hosted service.

For a physical iPhone or a browser connected to the **same local backend**, use
one command after `npm ci`:

```sh
make run
```

The command builds and starts the runtime, checks its health, and starts Expo in
LAN mode. Scan Expo's QR code with the iPhone Camera app to open it in Expo Go;
press `w` in the terminal for the web UI. The Mac and iPhone must be on the same
trusted Wi-Fi network, and both Expo CLI and iPhone Expo Go must be signed in to
the same Expo account. Open the printed `/health` URL in iPhone Safari first if
the app cannot connect. Set `REWIND_LAN_IP` to the Mac's reachable IPv4 address
if the command selects the wrong network interface. Use `make run-demo` for the
labelled synthetic camera path. The default `make run` leaves real camera
capture enabled. Press Ctrl-C to stop Expo and the runtime together.

This route uses the local synthetic members and SQLite service, not real user
authentication or private cloud media. Use non-sensitive test clips only.

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

Native real-account invite links require `EXPO_PUBLIC_INVITE_WEB_ORIGIN` to be
set at app-build time to the public HTTPS origin that serves the `/invite`
route. This is the link destination, separate from
`EXPO_PUBLIC_LOCAL_BASE_URL`, which points to the API. Web builds use their
current HTTPS origin automatically; a native build without the public origin
will explain that invite links are unavailable instead of sharing an API URL.

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

- [External-provider agentic scan trial](docs/vigolium-agentic.md)
- [Local-first boundary](docs/architecture/ADR-0001-local-first-sprint-0.md)
- [Camera capture boundary](docs/architecture/ADR-0002-camera-capture-boundary.md)
- [Domain contracts](docs/domain/contracts.md)
- [Local Demo runbook](docs/local-demo-runbook.md)
- [Hosted Demo persistence](docs/architecture/hosted-demo-persistence.md)
- [Hosted deployment, backup, and recovery](deploy/README.md)
- [Sprint planning index and canonical dates](doc/README.md)
