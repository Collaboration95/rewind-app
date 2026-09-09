# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
for a group cycle and experiencing them together through a delayed reveal.

This repository contains the Sprint 0 foundation and local demo profile selection. The app is
deliberately honest about what is not implemented yet; local demo data is not
authentication, a secure account, or a cloud service.

## Clean start

Supported baseline: Node.js 22 LTS (Node.js 20.19.4 or newer) and npm 10 or
newer, with a current Chromium-based browser for the Expo web demo.

```sh
npm ci
npm run check
npm run web
```

Open the local URL printed by Expo, normally `http://localhost:8081`.

The clean-start path does not require AWS credentials, an account, private
media, or a deployed service. Native Android and device permission work are
future implementation scope.

## iOS and web development sessions

On macOS, `scripts/rewind-dev.sh` manages a repeatable Expo Go iOS session and
the Expo web preview. It defaults to the iPhone 15 Pro and rejects iPhone SE or
older simulators.

```sh
scripts/rewind-dev.sh ios-up   # boot iPhone 15 Pro, start Metro, open Expo Go
scripts/rewind-dev.sh web-up   # start the browser preview on port 8082
scripts/rewind-dev.sh status
scripts/rewind-dev.sh down     # stop both servers and shut down the simulator
```

Use `ios-down` or `web-down` when stopping only one session. The script uses
the local Expo Go bundle when available; set `EXPO_GO_APP_PATH` to provide a
specific `.app` bundle. `IOS_DEVICE_NAME`, `IOS_DEVICE_UDID`, `IOS_PORT`, and
`WEB_PORT` can be overridden for a supported setup.

## Quality commands

| Command                   | Purpose                                   |
| ------------------------- | ----------------------------------------- |
| `npm run format:check`    | Verify repository formatting              |
| `npm run lint`            | Run ESLint                                |
| `npm run typecheck`       | Run strict TypeScript checking            |
| `npm test`                | Run scaffold and component tests          |
| `npm run check`           | Run all baseline checks                   |
| `npm run build:web`       | Export the Expo web bundle                |
| `npm run test:responsive` | Check layouts at supported viewport sizes |

GitHub Actions runs the baseline and responsive browser checks on pushes to
`main` and pull requests.

## Local demo profiles

Choose one of five synthetic members in the profile picker. The current member
changes immediately, and the last selection is saved on this device using
AsyncStorage. A new installation or missing/invalid selection starts with Amber.
Storage failures display a message and allow retrying the save.

For a clean demo reset, clear this app's local storage (site data on web or app
data on Android) and relaunch. This restores the default selection and the same
five profiles and one group. Selection is local to this device; it is not sign-in
or multi-device membership.

## Repository map

- `App.tsx` — low-fidelity Home screen, profile picker, main navigation, and explicit unavailable states.
- `src/profiles/` — reusable profile picker and shared current-member provider.
- `src/data/` — synthetic repositories and local selection storage.
- `src/domain/` — framework-independent profile, group, and storage interfaces.
- `docs/architecture/` — local-first boundary decision.
- `docs/domain/` — glossary and framework-independent contracts.

The Sprint 0 plan and issue acceptance criteria remain the source of product
scope. Group capsule state, camera capture, chat, archive playback,
authentication, and cloud services are follow-up work.
