# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
for a group cycle and experiencing them together through a delayed reveal.

This repository contains the Sprint 0 foundation, local demo profile selection,
and a read-only group capsule summary. The app is deliberately honest about
what is not implemented yet; local demo data is not authentication, a secure
account, or a cloud service.

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
- `src/domain/` — framework-independent profile, group, cycle, and storage interfaces.
- `src/theme.ts` — shared React Native color tokens mirrored by `DESIGN.md`.
- `docs/architecture/` — local-first boundary decision.
- `docs/domain/` — glossary and framework-independent contracts.
- `planning/sprints/` — Sprint 1 extension, runtime gate, and fallback agreement.

The Sprint 0 plan and issue acceptance criteria remain the source of product
scope. Camera capture, chat, archive playback, authentication, and cloud
services remain follow-up work.
