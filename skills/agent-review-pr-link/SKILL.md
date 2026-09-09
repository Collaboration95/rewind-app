---
name: agent-review-pr-link
description: Review a GitHub pull request against its linked issue, repository instructions, acceptance criteria, tests, accessibility, security, and CI, then publish a standardized review comment without approving or merging.
metadata:
  short-description: Standardized independent PR review
  compatibility: "Codex, Claude Code, and OpenCode"
---

# Agent PR review

Use this skill only when explicitly invoked with a concrete GitHub PR URL, for
example `/agent-review-pr-link https://github.com/OWNER/REPO/pull/123`.

Before reviewing, read the repository's portable review contract at
`.github/agent-review-pr-prompt.md` completely. That prompt is the shared
contract for Codex, Claude Code, and OpenCode; this file is the invocation
wrapper.

## Required behaviour

- Review the PR's current diff against its actual base branch.
- Read repository instructions, linked Issues, acceptance criteria, explicit
  exclusions, and relevant planning or architecture documents.
- Run relevant documented local checks and report exactly what ran. If the code
  does not compile, typecheck, or build, continue the review and publish the
  failure as an actionable finding instead of silently stopping.
- For UI changes, an iOS emulation attempt is required: explicitly select Expo
  Go on an iPhone 14 or newer simulator and launch with `npm start -- --ios
  --lan --clear`. Never use or fall back to an iPhone SE simulator. Inspect the
  relevant states and capture screenshots when they materially support a
  finding or acceptance claim. If the required simulator, Expo Go, or
  screenshot capture is unavailable, report that check as not run; never
  fabricate screenshots or claim native verification.
- When the review ends, stop the Metro process started for the review, terminate
  Expo Go, shut down the selected simulator with `xcrun simctl shutdown <UDID>`,
  and quit the Simulator app/window if the agent launched it. Never leave an
  emulator running.
- Check correctness, tests, integration, security/privacy, accessibility/UX,
  maintainability, evidence, and issue traceability.
- Report only actionable findings with P0–P3 severity, location, impact, and a
  practical fix direction.
- Publish one concise top-level PR comment using the portable output format.
- Use `BLOCKED` only when the PR cannot be meaningfully evaluated because a
  required input or environment is unavailable. A failing check is normally a
  review finding, not a reason to omit the review.

## Prohibited actions

Do not modify files, create commits, push branches, alter Issue or Project
status, approve the PR, merge it, or delete remote data. An agent review
supplements required human review; it never replaces it.

The explicit invocation authorizes publishing the single review comment for the
provided PR URL, but not any broader GitHub mutation.
