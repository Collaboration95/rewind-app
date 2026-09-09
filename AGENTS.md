# Rewind working agreement

`rewind-app` is the authoritative workspace for this SWE5006 project's code,
backlog, and Sprint delivery. Do not use `rewind-v1` as evidence of current
scope or delivery status.

## GitHub Issues

- A GitHub Issue defines the intended outcome, acceptance criteria, and
  exclusions for a change.
- Before implementing an issue, inspect the issue and relevant code. Discuss
  only material unresolved choices with the user, one at a time.
- Once the approach is agreed, add one concise issue comment recording the
  material decisions, scope, and implementation plan. Do not create separate
  decision, evidence, or completion documents.
- Keep the issue and Project status honest. Link the PR to the issue and report
  only checks that actually ran.
- `skills/agent-solve-issue/SKILL.md` is the shared guided workflow. The
  `.claude/skills`, `.codex/skills`, and `.opencode/skills` links point to the
  same canonical `skills/` directory.

## Scrum

- Each Sprint has a Sprint Goal and a visible Sprint Backlog. Use the Project
  board to show the current state of work.
- The team holds the Sprint Planning, Daily Scrum, Sprint Review, and Sprint
  Retrospective. Capture resulting work or decisions as GitHub Issues.
- Definition of Done: the issue acceptance criteria are met, relevant automated
  checks pass, the change is reviewed, and the increment is usable.
- Screenshots, separate evidence folders, completion notes, second-machine
  checks, mandated agent reviews, and prescribed reporting templates are not
  required unless a specific issue makes one the deliverable.

## Permitted use of `rewind-v1`

`rewind-v1` is a local, non-authoritative MVP reference only. It may be read
to inspect possible feature ideas, local paths, application structure, or
technical approaches. It must not be used to determine actual project scope,
implementation status, deployment approach, GitHub workflow, or backlog.

## Native iOS simulator verification

For native verification, use an iPhone 14 or newer simulator and Expo Go rather
than relying only on browser viewport emulation. Prefer a notched or Dynamic
Island device (for example, iPhone 14 Pro or iPhone 15 Pro) so safe-area
behavior is exercised. Do not use iPhone SE as the native-review baseline.

```sh
npm start -- --ios --lan --clear
```

Use `--lan`, not `--localhost`. On this machine, Metro may bind to the IPv6
loopback interface while Expo Go is given an IPv4 `127.0.0.1` URL. That produces
the misleading Expo Go error “Could not connect to the server.” The LAN launch
advertises the Mac's reachable address and has been verified to start the app
on an iPhone simulator.

Before native review, run `npm run check`; use `npm run test:responsive` for
the browser layout regression suite as complementary—not substitute—evidence.
