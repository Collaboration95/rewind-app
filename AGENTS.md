# Rewind working agreement

`rewind-app` is the authoritative workspace for this SWE5006 project's code,
backlog, and Sprint delivery. Do not use `rewind-v1` as evidence of current
scope or delivery status.

## Precedence

These delivery rules take precedence over conflicting text in older issue
bodies, comments, and planning documents under `doc/planning/`. This includes
"Execution contract", "Delivery stage", "Observable acceptance",
"Prerequisites", estimates, PR batches, and operator, verifier, provider,
device verifier, or independent acceptance roles. Read an issue for its problem
and intended outcome; those roles are not prerequisites for closing it.
Issues labelled `archived` are out of scope; `mvp` issues are the active
backlog.

## Definition of Done

An issue is Done when all four conditions hold:

1. Its core outcome works, checked in the cheapest real environment that
   exercises it (see Verification tiers).
2. `npm run test:fast` passes and the PR's aggregate Quality check is green.
3. One review-agent pass on the PR is complete and blocking findings are fixed.
   No human approval is needed for routine `dev` PRs.
4. The PR is merged to `dev`. Then close the issue with a one-line comment
   linking the PR.

Screenshots, evidence comments or folders, completion notes, decision documents,
second-machine or physical-device runs, repeated rehearsals, independent human
acceptance, and Project-board reconciliation beyond setting Status are not
required unless the issue itself makes them the deliverable.

## Verification tiers

| Change                                                                   | Check                                                                        | Needs hosted dev? |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------- |
| UI only (styling, copy, layout)                                          | `npm run web`; inspect in browser                                            | No                |
| Client logic                                                             | Focused test, then `npm run test:fast`                                       | No                |
| Server logic                                                             | `make run` (local server + SQLite), exercise in browser; focused server test | No                |
| Real-account flows (sign-in, groups, capture, Archive)                   | `make run-real` (10-minute cycles), open `http://localhost:8090`             | No                |
| HTTPS-only behaviour (iPhone camera, PWA install, web push, S3, Cognito) | Hosted dev URL after normal deploy                                           | Yes               |

Run `npm run test:slow`, coverage, and `npm run test:a11y` for changes touching
web export, routing, PWA, or accessibility, and before a `main` promotion.
Otherwise they are not per-PR requirements. Limit focused diagnosis to two
attempts per issue; then record the blocker and move on. Never remove assertions.

## Deployments

Every merge to `dev` deploys to hosted dev automatically. This is intended. A
deploy is not an acceptance gate and needs no evidence comment.

## Subagent delegation

When asked to “launch”, “start”, “spawn”, or “use” a **subagent**, create an
in-thread subagent with the runtime (for example, `multi_agent_v1__spawn_agent`).
Do not substitute a separate task, thread, or chat unless explicitly requested.

## GitHub Issues and writing

Before implementing, inspect the issue and relevant code; apply Precedence
above. An "Implementation approach" comment is optional for bug fixes and small
changes, and at most five lines for larger features. New issues contain
**Problem**, **Expected**, **How to check**, labels, and milestone. Add no
estimates, execution contracts, delivery stages, or role assignments.

Skills live in `skills/` (`.claude/skills`, `.codex/skills` and
`.opencode/skills` link to it): `ship-issues` implements one issue or a queue
of issues end to end; `verify-issue` drafts and files a new issue.

## Branch and review workflow

- Start issue branches from latest `dev` and target `dev` with focused PRs. The
  protected branch requires a PR, green up-to-date aggregate Quality, and
  resolved conversations; routine PRs need no human approval.
- For authentication, private media access, database migrations, deployment,
  or infrastructure, use higher-tier GPT-6.1 Sol or Claude review and leave
  merging to the owner.
- Keep `main` as the reviewed release branch. Promote a small, green `dev` diff
  with a PR when wanted; no daily promotion or reviewer schedule is required.
  Existing `main` approval and Quality rules remain.
- Reference issues in `dev` PRs without closing keywords; close after the
  Definition of Done. Never force-push protected branches.
- For urgent fixes, target `main` with normal review and checks, then bring the
  accepted fix to `dev` by PR. No separate production branch is used.

## Batched agent runs

An agent may process an ordered Markdown issue queue in one run. Use one branch
and PR per issue or tightly related group, with one review-agent pass per PR.
Apply the two-attempt rule per issue; record blockers in the queue and continue.
Give each issue a short, fresh context brief. Do not load
large plan or prompt files; see Frozen folders.

## Project documentation and Scrum

`doc/README.md` is the planning workspace entry point; current context,
proposals, Sprint plans, and evidence live under `doc/planning/`. Do not use the
retired top-level `planning/` path or separate planning repository for current
scope or delivery decisions.

Use zero-based names: Sprint 0 (foundation), Sprint 1 (13–26 Sep 2026), Sprint
2 (27 Sep–10 Oct 2026), Sprint 3 (11–24 Oct 2026). Milestones and the active
Project board use these names; do not call the 27 Sep–10 Oct period Sprint 3.
Hold Sprint Planning, Daily Scrum, Sprint Review, and Retrospective; capture
resulting work or decisions as GitHub Issues.

## Tracking work

GitHub Project boards are not maintained; do not update them. Track work with
three things only:

- **Milestone** = the Sprint the issue belongs to.
- **`mvp` label** = on the delivery path. **`archived`** = closed as out of
  scope.
- **`doing` label** = being worked on now. Add it when you start an issue;
  remove it if you stop without finishing. Closing the issue ends it.

`make issues` lists the current Sprint's Doing, To do and Done issues.

## Product decisions (4 October 2026)

- The real-account app is the product. The synthetic Demo is frozen: keep it
  working for tests and local runs, but add no features to it and do not keep
  it in parity. Git tag `demo-frozen-20261004` marks the last state where both
  were maintained, in case the Demo needs restoring or rebuilding.
- Photo and video capture both stay.
- Reminders use web push only (browser and installed iPhone Home Screen app).
  Expo/native push is paused; leave its code disabled, do not extend it.
- Managed OIDC (Cognito) is deferred; the existing sign-in stays.
- Media storage: `disk` for local runs, `s3` for hosted. Do not extend the
  `local` object-store backend.
- iOS is delivered as the PWA. Compiled native iOS is out of scope.

## Frozen folders

Do not read, modify or generate anything in these unless the user names the
folder or document explicitly:

- `doc/planning/report/`: the final report and presentation. It is worked on
  only near the end of the project.
- `doc/planning/archive/`: superseded plans, handoffs and long agent prompts.

## Workspace boundaries

`rewind-v1` and `rewind-v1-source.zip` are archived; do not inspect, extract,
modify, or use them. Top-level `src/` is retired; current source belongs in
`rewind-app/`.

## Native iOS simulator verification

For native verification, use Expo Go on an iPhone 14 or newer simulator,
preferably notched or Dynamic Island (iPhone 14 Pro or 15 Pro). Do not use SE.

```sh
npm start -- --ios --lan --clear
```

Use `--lan`, not `--localhost`: Metro may bind to IPv6 loopback while Expo Go
gets IPv4 `127.0.0.1`, causing “Could not connect to the server.” LAN advertises
the Mac's reachable address and has been verified on an iPhone simulator.

For diagnosis, select one exact test file with the existing runner:

```sh
npm run test:focused -- frontend tests/VideoCaptureScreen.test.tsx
npm run test:focused -- server server/tests/cycles.test.mjs
npm run test:focused -- root tests/architecture.test.mjs
```

Use a focused command to diagnose, then run `npm run test:fast` after code
changes. Clean up only temporary data and processes owned by this run; do not
stop unrelated processes.

## Scope guard

Do not add infrastructure, environments, CI workflows, security scanners, or
tooling unless an `mvp` issue requires it.
