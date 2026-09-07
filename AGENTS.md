# Rewind app planning boundary

`rewind-app` is the authoritative workspace for this SWE5006 project's
delivery, Sprint planning, Agile artefacts, GitHub Issues, GitHub Project, and
deployment decisions.

## GitHub and Agile workflow

- Use this repository's `origin` remote to identify the GitHub repository for
  all Sprint, backlog, Issue, Project, milestone, board, and delivery work.
- Do not use `rewind-v1` GitHub remotes, issues, Projects, branches, history,
  deployment setup, or execution status as evidence for this project.

## Shared agent PR review

- The portable review contract is `.github/agent-review-pr-prompt.md`.
- Codex can invoke the wrapper skill as `/agent-review-pr-link <PR_URL>`.
- Other coding agents should use the same prompt file and output format.
- An agent review may inspect the PR, run safe checks, and publish one review
  comment; it must not approve, merge, edit files, push branches, or change
  issue/Project state.

## Shared agent issue solving

- The canonical guided issue-solving skill is `skills/agent-solve-issue/SKILL.md`.
- Use it explicitly as `/agent-solve-issue <issue-number-or-URL>` for a
  walkthrough or implementation session in the current coding context.
- `.claude/skills` and `.codex/skills` point to the canonical `skills/` folder;
  do not create separate vendor-specific copies of shared skills.
- `.opencode/skills` points to the same canonical `skills/` folder for OpenCode.
- The portable PR body template is `.github/pull_request_template.md`.
- Related issues may share one branch and PR when they form one coherent
  change-set; every issue must still have separate acceptance evidence and
  traceability.

## Permitted use of `rewind-v1`

`rewind-v1` is a local, non-authoritative MVP reference only. It may be read
to inspect possible feature ideas, local paths, application structure, or
technical approaches. It must not be used to determine actual project scope,
implementation status, deployment approach, GitHub workflow, or backlog.
