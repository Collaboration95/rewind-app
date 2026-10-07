# Claude Code instructions

Read `AGENTS.md` (imported below) before continuing. It holds the shared rules
for every agent. The rules in this file apply to Claude Code only and take
precedence over `AGENTS.md` where they differ.

## Claude-only rules

- **GitHub authority.** Claude may merge PRs (including authentication, private
  media, migration, deployment and infrastructure PRs) and take any other GitHub
  action that does not permanently lose data. That covers closing, labelling,
  commenting, milestones and merged-branch deletion. Never delete issues,
  unmerged branches, releases or tags, and never force-push protected branches.
- **Be agentic. Ask the owner only when truly blocked.** Do the work end to end
  yourself: code, infrastructure (Terraform/AWS with the existing profiles),
  deploys, GitHub actions, verification. Never hand the owner a script or
  command to run when you can run it. The only reasons to stop and ask are a
  decision only the owner can make, a check that needs their physical device,
  or a sign-in that needs their password. Design flows so no one handles
  credentials by hand (for example, Terraform writes them where the deploy
  reads them).
- **One PR per batch.** Bundle all the issues and fixes worked on together into
  a single PR (one branch, one merge). Split only when part
  of the batch is blocked or unrelated enough to need a separate rollback.
- **Parallel sessions.** Several agents work in this repo at once. For a large
  or multi-file task, create a worktree from `origin/dev` (with its own
  `npm ci`) before the first Write, and first check `gh pr list` for an open
  PR touching the same files; if one does, stop and say so. Minor fixes, or
  changes the owner explicitly asked for in this checkout, may be made in
  place. Never switch the main checkout's branch or kill processes you did
  not start.
- **Review agent.** Only for overnight or batched runs (a queue of several
  issues), or when the owner types `/codex-review`. Never on an ordinary PR,
  and never report it as a missing step. When it runs: once per PR, from a
  worktree of the PR head, via `make review` (GPT-6 Luna, high effort, fast
  tier), or `make review MODEL=gpt-6.1-sol` (optional `EFFORT=`, default
  medium) for sensitive work or when the owner names a model. Fix blocking
  findings; record a non-blocking or false-positive finding in one PR comment.
  Merge once Quality is green.

@AGENTS.md
