---
name: agent-solve-issue
description: Understand, discuss, implement, and test a GitHub issue in the current coding session, recording material decisions in the issue.
metadata:
  short-description: Guided issue solving with an issue decision comment
  compatibility: "Codex, Claude Code, and OpenCode"
---

# Guided issue solving

Use this skill for a GitHub Issue walkthrough or implementation session.

## Walkthrough

Read the complete issue, its relevant comments, repository instructions, and
the affected code. Explain the current behaviour, requested outcome, scope,
and likely implementation boundary. Do not change files.

## Solve

1. Inspect the issue, working tree, existing patterns, relevant tests, and
   applicable project context under `doc/planning/`.
   Treat the issue's acceptance criteria and exclusions as the scope.
2. Resolve only material product, UX, architecture, privacy, API, or platform
   choices. Ask one question at a time; recommend the smallest suitable option.
   Do not ask questions that the repository can answer.
3. Before coding, post one concise comment to the issue:

   ```md
   ## Implementation approach

   - Decisions: <material agreed choices>
   - Scope: <included and excluded>
   - Plan: <short ordered steps>
   ```

   Do not include secrets, personal data, or sensitive local paths.
4. Implement the agreed scope. Preserve unrelated work and stop if a new
   material decision or blocker appears.
5. Add or update focused tests and run the relevant documented checks. For
   local diagnosis, use one exact file with `npm run test:focused -- frontend
   <tests/name.test.tsx>`, `npm run test:focused -- server
   <server/tests/name.test.mjs>`, or `npm run test:focused -- root
   <tests/name.test.mjs>`. A focused pass does not replace the documented
   fast, slow, coverage, PR Quality, or review requirements. Limit focused
   diagnosis to two attempts; do not remove assertions to obtain a pass. Clean
   up only resources owned by the current run. For UI changes, verify
   accessibility behaviour that the issue or platform supports. Report only
   commands that actually ran.
6. Open a focused PR against `dev` linked with `Refs #123`. After its acceptance
   criteria are verified, relevant checks pass, the change is reviewed, and the
   accepted change is on `dev`, close the Issue explicitly and move it to Done.
   Do not use a closing keyword in the integration PR.

If the issue reference is ambiguous, the working tree overlaps unsafely, or the
scope cannot be resolved from the issue and user decisions, stop and explain
what is needed.
