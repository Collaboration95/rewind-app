# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
for a group cycle and experiencing them together through a delayed reveal.

This repository contains the Sprint 0 foundation, explicit local Demo access,
local group creation, a read-only group capsule summary, and the local runtime
boundary needed by the next feature increment. The app is deliberately honest
about what is not implemented yet; synthetic local data is not authentication,
a secure account, or a cloud service.

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
media, or a deployed service. The camera route now has an SDK-compatible native
permission/capture boundary; cloud media, recording, and upload remain future
scope.

For simulator review, set `EXPO_PUBLIC_CAMERA_MODE=demo` to use the explicit,
labelled fixture camera. This path never claims a physical image was captured.
Set it to `demo-denied` to exercise the denied-permission and retry UI. Leaving
the variable unset uses the native `ExpoCameraPlatform`; a physical device is
required for a real camera preview and still capture.

Set `EXPO_PUBLIC_DEMO_ACCESS=entry` when a deterministic screenshot or manual
review needs to start at the Demo access chooser; the normal clean-start path
restores the synthetic Amber session for continuity.

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

The owner-only local demo control is available to integration callers as
`POST /cycles/demo/advance?groupId=...&memberId=...&advanceSeconds=...`. It
shifts the persisted cycle boundaries, records the old/new instants in local
SQLite, and returns the updated cycle. Only a membership row with the
persisted `owner` role can use it; non-owners receive the same safe denial and
no cycle or event data.

## Quality commands

| Command                      | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `npm run format:check`       | Verify repository formatting                               |
| `npm run lint`               | Run ESLint                                                 |
| `npm run architecture:check` | Verify framework/device import boundaries                  |
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

## Local Demo access

The app maintains an explicit local Demo session for one of five synthetic
members. The session record is saved on this device using AsyncStorage and has
an eight-hour bounded lifetime; it contains no credential or secure identity
claim. The clean-start fixture uses Amber for continuity. Settings can end the
session and return to the Demo access entry, where another sample member can be
chosen. Runtime-connected sessions are revalidated by the local SQLite service.

Storage/runtime failures remain in the app with an actionable retry path.

## Local groups and settings

Settings shows the current synthetic actor, group, and owner/member role. An
owner can create a local group with a required name (80 characters maximum) and
either a built-in prompt or a short custom prompt (160 characters maximum).
Creation validates before persistence and commits the owner membership, group,
and collecting cycle atomically. The cycle starts at creation and lasts exactly
one day with the demo contribution allowance.

Settings also provides a confirmed **Reset local Demo data** action. Reset
removes the saved local Demo session, locally created groups, and local
selection, accepted still-image metadata, and app-owned cached still files,
then restores the deterministic fixture. It does not touch source files,
migrations, or remote data.

If the app cannot be opened far enough to reach Settings, clearing this app's
local storage (site data on web or app data on Android) and relaunching restores
the same fallback fixture. Selection is local to this device; it is not
multi-device membership.

## Group capsule

The Home screen reads the active Demo session actor's current synthetic group
and cycle through the local repository boundary. It shows the group name, current prompt,
locally derived countdown, and member-scoped contribution allowance. Sprint 0
seeds a collecting cycle with a five-contribution/30-second limit and zero
usage. While the cycle is locked, the app shows only sealed placeholders and
text; it does not load or expose media, playback, or sharing actions.

## Repository map

- `App.tsx` — local Demo access entry, Home/settings/group-create screens, main navigation, and explicit unavailable states.
- `src/capsule/` — capsule loading states, countdown formatting, and Home summary.
- `src/profiles/` — reusable synthetic-member picker and compatibility current-member provider.
- `src/session/` — persisted Demo access lifecycle and local session storage.
- `src/domain/groups.ts` — group/prompt validation and one-day cycle constants.
- `src/data/` — synthetic repositories plus local group/session persistence adapters.
- `src/runtime/` — typed local API client, repository adapters, and connection state UI.
- `src/capture/` — capability/permission ports, Expo SDK 57 camera and file adapters, simulator fixture, still preview, and metadata-only lifecycle.
- `src/domain/` — framework-independent profile, group, cycle, and storage interfaces.
- `server/src/` — typed local HTTP service, configuration, SQLite access, FFmpeg probe, and policy.
- `server/src/session/` — explicit local Demo access lifecycle and SQLite session boundary.
- `server/src/cycles/` — injected-clock timing engine and owner-only demo control.
- `server/src/audit/` and `server/src/jobs/` — redacted local diagnostics and audited job helpers.
- `server/migrations/` and `server/fixtures/` — versioned schema and deterministic synthetic seed.
- `src/theme.ts` — shared React Native color tokens mirrored by `DESIGN.md`.
- `docs/architecture/` — local-first and camera capture boundary decisions.
- `docs/domain/` — glossary and framework-independent contracts.
- `scripts/check-architecture.mjs` — baseline framework/device boundary guard.
- `planning/sprints/` — Sprint 1 extension, runtime gate, and fallback agreement.

The Sprint 0 plan and issue acceptance criteria remain the source of product
scope. Chat, archive playback, authentication, and cloud services remain
follow-up work; the camera directory is a local still-capture boundary only.
