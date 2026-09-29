# Rewind working agreement

`rewind-app` is the authoritative workspace for this SWE5006 project's code,
backlog, and Sprint delivery. Do not use `rewind-v1` as evidence of current
scope or delivery status.

## Subagent delegation

When the user asks to “launch”, “start”, “spawn”, or “use” a **subagent**,
create an in-thread subagent with the subagent runtime (for example,
`multi_agent_v1__spawn_agent`). Do **not** create a separate Codex task,
thread, or chat as a substitute.

Only create a separate task/thread when the user explicitly asks for a new
task, thread, or chat.

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

## Branch and review workflow

- Start issue branches from the latest `dev` and target `dev` with focused PRs.
  The protected `dev` branch requires a PR, an up-to-date green aggregate Quality
  check, and resolved conversations. Routine `dev` PRs do not require a human
  approval, so do not describe their merge as independent acceptance.
- Request human review before integrating changes to authentication, access to
  private media, database migrations, deployment, or infrastructure. Do not
  bypass a material review need merely because `dev` allows zero approvals.
- Keep `main` as the reviewed release branch. Promote a small, green `dev` diff
  to `main` with a PR when an update is wanted; no daily promotion or reviewer
  schedule is required. The existing `main` approval and Quality rules remain.
  A merge to `main` is not proof of deployment or user acceptance.
- Reference issues in `dev` PRs without closing them. Move an issue to Done only
  when its acceptance criteria are verified, relevant checks pass, the change
  has been reviewed, and the accepted change is on `main`. Otherwise keep its
  actual state visible in the Project board.
- For an urgent fix, target `main` with its normal review and checks, then
  bring the accepted fix back to `dev` through a PR. Do not force-push either
  protected branch. A separate production branch is not part of this workflow.

## Project documentation

- `doc/README.md` is the entry point for the consolidated planning workspace.
- Current project context, proposals, Sprint plans, and planning evidence live
  under `doc/planning/`.
- Do not recreate or use the retired top-level `planning/` path or the separate
  planning repository for current Rewind app scope and delivery decisions.

## Scrum

- Use zero-based Sprint names consistently: Sprint 0 (foundation), Sprint 1
  (13–26 Sep 2026), Sprint 2 (27 Sep–10 Oct 2026), and Sprint 3
  (11–24 Oct 2026). GitHub milestones and the active Project board use these
  names; do not call the 27 Sep–10 Oct period Sprint 3.
- Each Sprint has a Sprint Goal and a visible Sprint Backlog. Use the Project
  board to show the current state of work.
- The team holds the Sprint Planning, Daily Scrum, Sprint Review, and Sprint
  Retrospective. Capture resulting work or decisions as GitHub Issues.
- Definition of Done: the issue acceptance criteria are met, relevant automated
  checks pass, the change is reviewed, and the increment is usable.
- Screenshots, separate evidence folders, completion notes, second-machine
  checks, mandated agent reviews, and prescribed reporting templates are not
  required unless a specific issue makes one the deliverable.

## Workspace boundaries

- `rewind-v1` has been archived as `rewind-v1-source.zip`. Do not inspect,
  extract, modify, or use the ZIP or the archived `rewind-v1/` directory.
- The top-level `src/` directory is retired. Do not recreate or use it as a
  source of project code; current project work belongs in `rewind-app/`.

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

For a local feedback loop, run `npm run test:fast` after a code change. Run
`npm run test:slow` for web export, browser behavior, and production-shaped
journeys. Use `npm run test:coverage:frontend` and
`npm run test:coverage:server` to inspect separate frontend and server coverage;
the frontend has a 70% statement gate, while server coverage is measured but
has no percentage gate yet. For a PR, verify the relevant checks and the
aggregate Quality check. Before native review, run `npm run check`; use
`npm run test:responsive` for browser layout regression as complementary
evidence.
