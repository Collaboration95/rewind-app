# Rewind

Rewind is a local-first SWE5006 prototype for collecting short shared moments
for a group cycle and experiencing them together through a delayed reveal.

This repository currently contains the Sprint 0 foundation. The app shell is
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

## Quality commands

| Command                | Purpose                          |
| ---------------------- | -------------------------------- |
| `npm run format:check` | Verify repository formatting     |
| `npm run lint`         | Run ESLint                       |
| `npm run typecheck`    | Run strict TypeScript checking   |
| `npm test`             | Run scaffold and component tests |
| `npm run check`        | Run all baseline checks          |
| `npm run build:web`    | Export the Expo web bundle       |

GitHub Actions runs `npm run check` on pushes to `main` and pull requests.

## Repository map

- `App.tsx` — low-fidelity Home screen, main navigation, and explicit unavailable states.
- `docs/architecture/` — local-first boundary decision.
- `docs/domain/` — glossary and framework-independent contracts.

The Sprint 0 plan and issue acceptance criteria remain the source of product
scope. Profile selection, group capsule state, camera capture, chat, archive
playback, persistence, authentication, and cloud services are follow-up work.
