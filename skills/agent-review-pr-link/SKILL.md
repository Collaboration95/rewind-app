---
name: agent-review-pr-link
description: Review a GitHub pull request against its linked issue, repository instructions, acceptance criteria, tests, accessibility, security, and CI, then publish a standardized review comment without approving or merging.
metadata:
  short-description: Standardized independent PR review
  compatibility: "Codex, Claude Code, and OpenCode"
---

# Agent PR review

Use this skill only when the user explicitly invokes it with a concrete GitHub
PR URL, for example `/agent-review-pr-link https://github.com/OWNER/REPO/pull/123`.

Before reviewing, read the repository's canonical prompt at
`.github/agent-review-pr-prompt.md` completely. That file is the portable review
contract for other coding agents; this skill is only the Codex invocation
wrapper.

## Required behaviour

- Review the current PR diff and its actual base branch.
- Read repository instructions, linked issues, acceptance criteria,
  out-of-scope requirements, and relevant planning/architecture documents.
- Run relevant documented local checks and report exactly what ran.
- Check correctness, tests, integration, security/privacy, accessibility/UX for
  UI changes, maintainability, and evidence.
- Report only actionable findings with P0–P3 severity, file/line, impact, and a
  practical fix direction.
- Publish one concise top-level PR comment using the canonical output format.
- If the PR cannot be evaluated, publish `BLOCKED` with the concrete missing
  input or failed check.

## Prohibited actions

Do not modify files, create commits, push branches, alter issue or Project
status, approve the PR, merge the PR, close issues, or delete remote data. An
agent review supplements the required human review; it never replaces it.

The invocation authorizes publishing the review comment for the supplied PR
URL, but not any broader GitHub mutation.
