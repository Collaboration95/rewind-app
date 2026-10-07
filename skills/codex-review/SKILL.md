---
name: codex-review
description: One Codex review pass on a Rewind PR. Only when the owner types /codex-review.
disable-model-invocation: true
argument-hint: '<pr number> [model]'
---

# Codex review

1. Check out the PR head in a worktree from the scratchpad:
   `git worktree add <dir> origin/<head branch>` after `git fetch origin`.
2. From that worktree run `make review`, or `make review MODEL=<model>` if the
   owner named one. Use `MODEL=gpt-6.1-sol` for auth, private media,
   migrations, deploy or infra.
3. Report the blocking findings with a one-line fix each, and the rest in one
   line. Fix blockers only if the owner asks. Remove the worktree when done.
