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

## Atelier Home concept, language, and debug mode

This branch presents the Atelier Home concept for #253 and #189, built on the
"Today's moment" concept. Home uses an illustrated sealed print for the prompt
and reveal status, a film strip for the remaining allowance, and one main action.
The countdown is collection time remaining, not a guaranteed film release time.
Photos are saved locally; submitted clips stay sealed until release in Archive.
The print is decorative and never displays unrevealed group media.

The Atelier presentation starts at commit `5c2a840`; its inherited Today baseline
is `cab41d8`. The full branch also includes earlier camera permission, clip
preview/library selection, and server orientation handling changes. This is a
draft UI alternative, not approval to merge or deploy.

For peer review, run the labelled Demo using the commands above, then:

1. On Home, identify the prompt, collection time, remaining count and seconds.
2. Choose **Add a moment**, use the labelled fixture, and accept a still locally.
   Confirm that the save message says no clip was uploaded and allowance is unchanged.
3. Enable Debug mode as described below. In **DEBUG**, select Home and preview
   processing, delayed, released, and allowance-used states. Follow the main action
   into Archive. A forced released state is a presentation preview, not proof of
   a real compiled film or a successful upload.
4. Return each screen to **Live data**. For actual clip submission and film playback,
   use the optional local runtime and its capture-to-release flow.
5. Record the commit, environment, tasks tried, hesitation or defects, and preferred
   design elements in #253. Both peer contributors must try the branch and post
   their own observations; a recording alone does not complete #189's cross-use.

Settings → **Display & developer** has two local preferences, both stored
only on the device:

- **Language / 语言** switches the visible copy between English and Simplified
  Chinese. Server messages without a translation stay in English.
- **Debug mode** adds a `DEBUG` chip to the header. Tap it on any screen to
  force one of the study states (loading, empty, denied, error, permission,
  review, uploading, queued, processing, sealed, delayed, released, allowance
  used) or to simulate a missing local runtime. Forced states are labelled
  presentation previews: they never write sessions, groups, contributions or
  media. Choose **Live data** or **Reset every screen to live data** to return.

To try it on a phone, install Expo Go, keep the phone on the same Wi-Fi as the
computer, and scan the QR code from:

```sh
npm start -- --lan --clear
```

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
- [Sprint planning index and canonical dates](doc/README.md)
