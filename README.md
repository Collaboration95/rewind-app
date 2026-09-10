# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
for a group cycle and experiencing them together through a delayed reveal.

This repository contains the Sprint 0 foundation, local demo profile selection,
a read-only group capsule summary, and the local runtime boundary needed by the
next feature increment. The app is deliberately honest about what is not
implemented yet; synthetic local data is not authentication, a secure account,
or a cloud service.

## Clean start

Supported baseline: Node.js 22 LTS (22.13.0 or newer for the built-in SQLite
runtime) and npm 10 or newer, with a current Chromium-based browser for the
Expo web demo.

```sh
npm ci
npm run check
npm run web
```

Open the local URL printed by Expo, normally `http://localhost:8081`.

The clean-start path does not require AWS credentials, an account, private
media, or a deployed service. Native Android and device permission work are
future implementation scope.

## Local runtime

The companion service is a local-only Node process. It binds to
`0.0.0.0:8787` for an explicitly trusted development LAN, exposes no public
hosting or credentials, and stores its SQLite file at the ignored
`.local-data/rewind.sqlite` path.

```sh
npm run server:preflight   # service + SQLite + LAN + FFmpeg gate
npm run server:start       # build and run the local service
npm run server:migrate     # create/migrate and seed .local-data/rewind.sqlite
npm run server:reset       # restore the deterministic five-member fixture
npm run server:diagnostics  # print safe local session/job events
```

The preflight creates a short synthetic MP4, scales it successfully, and then
checks that a deliberately missing input returns an actionable FFmpeg error.
If it reports no LAN interface, localhost remains usable on this Mac; a device
on the same Wi-Fi needs the Mac's advertised LAN URL and a firewall rule that
allows the chosen development port.

Configuration is intentionally small and local:

| Variable            | Default       | Purpose                                                     |
| ------------------- | ------------- | ----------------------------------------------------------- |
| `REWIND_HOST`       | `0.0.0.0`     | `127.0.0.1` for Mac-only use or `0.0.0.0` for a trusted LAN |
| `REWIND_PORT`       | `8787`        | Local service port; `0` is useful for tests                 |
| `REWIND_DATA_DIR`   | `.local-data` | Directory for the SQLite database and transient files       |
| `REWIND_FFMPEG_BIN` | `ffmpeg`      | FFmpeg executable or absolute path                          |

To point the Expo app at the service, set the public development variable
before starting Metro. The same setting works with localhost in a simulator
or the LAN address on a physical device:

```sh
EXPO_PUBLIC_LOCAL_BASE_URL=http://127.0.0.1:8787 npm start -- --ios --lan --clear
# physical device example:
EXPO_PUBLIC_LOCAL_BASE_URL=http://10.0.0.25:8787 npm start -- --lan --clear
```

When the variable is absent the app stays on the offline demo fixture. When it
is present, Home shows a connected, loading, or disconnected runtime card with
a retry action, and the capsule repositories use the typed local API adapter.
Protected group, message, contribution/clip, film, and download routes all
return the same safe `403` denial to non-members.

## Quality commands

| Command                      | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `npm run format:check`       | Verify repository formatting                               |
| `npm run lint`               | Run ESLint                                                 |
| `npm run typecheck`          | Run strict TypeScript checking                             |
| `npm test`                   | Run scaffold and component tests                           |
| `npm run check`              | Run all baseline checks                                    |
| `npm run build:web`          | Export the Expo web bundle                                 |
| `npm run test:responsive`    | Check layouts at supported viewport sizes                  |
| `npm run server:preflight`   | Verify the local service, SQLite, LAN, and FFmpeg gate     |
| `npm run server:test`        | Run local service, migration, and policy integration tests |
| `npm run server:diagnostics` | Print allowlisted local audit events                       |

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

## Group capsule

The Home screen reads the selected member's current synthetic group and cycle
through the local repository boundary. It shows the group name, current prompt,
locally derived countdown, and member-scoped contribution allowance. Sprint 0
seeds a collecting cycle with a five-contribution/30-second limit and zero
usage. While the cycle is locked, the app shows only sealed placeholders and
text; it does not load or expose media, playback, or sharing actions.

## Repository map

- `App.tsx` — low-fidelity Home screen, profile picker, main navigation, and explicit unavailable states.
- `src/capsule/` — capsule loading states, countdown formatting, and Home summary.
- `src/profiles/` — reusable profile picker and shared current-member provider.
- `src/data/` — synthetic repositories and local selection storage.
- `src/runtime/` — typed local API client, repository adapters, and connection state UI.
- `src/domain/` — framework-independent profile, group, cycle, and storage interfaces.
- `server/src/` — typed local HTTP service, configuration, SQLite access, FFmpeg probe, and policy.
- `server/src/session/` — explicit local Demo access lifecycle and SQLite session boundary.
- `server/src/audit/` and `server/src/jobs/` — redacted local diagnostics and audited job helpers.
- `server/migrations/` and `server/fixtures/` — versioned schema and deterministic synthetic seed.
- `src/theme.ts` — shared React Native color tokens mirrored by `DESIGN.md`.
- `docs/architecture/` — local-first boundary decision.
- `docs/domain/` — glossary and framework-independent contracts.
- `planning/sprints/` — Sprint 1 extension, runtime gate, and fallback agreement.

The Sprint 0 plan and issue acceptance criteria remain the source of product
scope. Camera capture, chat, archive playback, authentication, and cloud
services remain follow-up work.
