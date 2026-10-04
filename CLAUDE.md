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
  a single PR (one branch, one review pass, one merge). Split only when part
  of the batch is blocked or unrelated enough to need a separate rollback.
- **Review agent.** Every PR gets one Codex review pass before merge, run from
  a worktree of the PR head:
  - Large or sensitive work: GPT-6.1 Sol, medium effort.
    `codex exec review --base origin/dev -m gpt-6.1-sol -c model_reasoning_effort="medium"`
  - Simple changes: GPT-6 Luna, xhigh effort, fast tier.
    `codex exec review --base origin/dev -m gpt-6-luna -c model_reasoning_effort="xhigh" -c service_tier="priority"`

  Fix blocking findings, then merge once Quality is green. Record a
  non-blocking or false-positive finding in one PR comment.

@AGENTS.md
