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

## Shared PR review

- The portable review contract is `.github/agent-review-pr-prompt.md`.
- Invoke the wrapper explicitly as `/agent-review-pr-link <PR_URL>` when an
  independent standardized review is wanted; it is not mandatory for every PR.
- A review may inspect the PR, run safe checks, capture relevant screenshots,
  and publish one top-level review comment. It must not edit files, push
  branches, approve or merge the PR, or change Issue/Project state.

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

## Native iOS simulator verification (mandatory for UI/native review)

- Use Expo Go on an explicitly selected iPhone 14 or newer simulator (prefer a
  notched or Dynamic Island device such as iPhone 14 Pro or iPhone 15 Pro).
- Never launch, select, or fall back to any iPhone SE simulator, including the
  iPhone SE (3rd generation). Do not rely on whichever simulator happens to be
  booted; verify the selected device name and UDID first.
- If no iPhone 14+ simulator is available, report native verification as not
  run rather than using an older device.

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

When verification is finished, always clean up the session: stop the Metro
process started for the review, terminate Expo Go on the selected simulator,
shut that simulator down with `xcrun simctl shutdown <UDID>`, and quit the
Simulator app/window if the agent launched it. Never leave an emulator running.
