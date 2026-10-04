---
name: agent-solve-issue
description: Understand, implement, and verify a GitHub issue in the current coding session.
metadata:
  short-description: Guided issue solving under the lean Definition of Done
  compatibility: "Codex, Claude Code, and OpenCode"
---

# Guided issue solving

Use this skill for a GitHub Issue walkthrough or implementation session.

## Walkthrough

Read the complete issue, its relevant comments, repository instructions, and
the affected code. Explain the current behaviour, requested outcome, scope,
and likely implementation boundary. Do not change files.

## Solve

1. Inspect the issue, working tree, existing patterns, and relevant tests.
   Read planning context under `doc/planning/` only when the issue needs it.
   Read the issue for its problem and intended outcome. Apply the precedence and
   Definition of Done in `AGENTS.md`; issues labelled `archived` are out of
   scope and `mvp` issues are the active backlog.
2. Resolve only material product, UX, architecture, privacy, API, or platform
   choices. Ask one question at a time; recommend the smallest suitable option.
   Do not ask questions that the repository can answer.
3. Before coding, an "Implementation approach" comment is optional for bug
   fixes and small changes. For larger features, keep it to at most five lines.
   Record only material decisions, scope, and a short plan:

   ```md
   ## Implementation approach

   - Decisions: <material agreed choices>
   - Scope: <included and excluded>
   - Plan: <short ordered steps>
   ```

   Do not include secrets, personal data, or sensitive local paths.
4. Implement the agreed scope. Preserve unrelated work and stop if a new
   material decision or blocker appears.
5. Check the core outcome in the cheapest real environment that exercises it,
   using the verification tiers in `AGENTS.md`. Run `npm run test:fast`; run
   `npm run test:slow`, coverage, and `npm run test:a11y` only for the changes
   specified there or before a `main` promotion. Limit focused diagnosis to two
   attempts per issue; after that record the blocker and move on. Never remove
   assertions to get a pass. Clean up only resources owned by the current run.
6. Open a focused PR against `dev` linked with `Refs #123`. Ensure the aggregate
   Quality check is green and get one review-agent pass on every PR, fixing
   blocking findings. Use a higher-tier agent (GPT-6.1 Sol or Claude) for
   authentication, private media access, database migrations, deployment, or
   infrastructure changes; leave those merges to the owner. Routine `dev` PRs
   need no human approval. After merge to `dev`, close the issue with a one-line
   comment linking the PR. Do not use a closing keyword in the integration PR.

If the issue reference is ambiguous, the working tree overlaps unsafely, or the
scope cannot be resolved from the issue and user decisions, stop and explain
what is needed.
