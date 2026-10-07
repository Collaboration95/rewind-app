---
name: ship-issues
description: Implement one Rewind GitHub issue, a list of issue numbers, or a Markdown issue queue end to end, from branch through verification, PR, review agent, merge and closing the issue. Use when asked to fix, ship, solve or work through issues.
metadata:
  short-description: Ship one issue or a queue of issues to dev
  compatibility: 'Codex, Claude Code, and OpenCode'
---

# Ship issues

`AGENTS.md` sets the rules: Definition of Done, verification tiers, review and
merge rules, tracking labels and frozen folders. This skill is the procedure.

## Input

- One issue number, a list of numbers, or a path to a Markdown queue file.
- `next`: take the open `mvp` issues in the current Sprint milestone that are
  not labelled `doing`, oldest first.

For a list or `next`, write a queue file before starting, for example
`.local-data/queue-<date>.md`, with one line per issue:
`- [ ] #123 short title`. Update each line as you go:
`- [x] #123 → PR #456 merged`, `- [!] #123 blocked: <one line>`, or
`- [~] #123 → PR #456 awaiting owner merge`.

## Per issue

1. **Read narrowly.** Read the issue title, body and its last two comments,
   plus the code it touches. Apply the Precedence rule in `AGENTS.md`:
   ignore execution contracts, estimates and operator or verifier roles. Skip
   the issue if it is closed or labelled `archived`.
2. **Claim it.** `gh issue edit <n> --add-label doing`.
3. **Brief.** Write a context brief of at most ten lines: the goal, the files
   involved, the verification tier and the check that proves it. When working
   through a queue, hand each issue to a fresh subagent with only this brief
   and `AGENTS.md`, and run independent issues in parallel, each in its own
   git worktree. Never pass whole planning documents to a subagent.
4. **Branch.** Create `<prefix>/<n>-<slug>` from the latest `origin/dev`. Use
   `git worktree add` instead when running issues in parallel.
5. **Implement** the smallest change that delivers the issue's outcome. Ask the
   user only about material product or privacy choices. In an unattended
   queue, choose the smallest reasonable option and state it in the PR body.
6. **Verify** with the cheapest tier that exercises the change (see
   `AGENTS.md`). Run a focused test first, then `npm run test:fast`. Stop after
   two failed attempts: mark the issue blocked in the queue, remove `doing`,
   and move to the next issue. Never delete or weaken assertions.
7. **PR** to `dev` with `Refs #<n>` (no closing keyword). The body has two
   short parts: what changed, and which checks actually ran.
8. **Review agent.** Run one review pass and fix the blocking findings:
   - `make review` from the PR head's worktree.
   - For auth, private media, migrations, deploy or infra:
     `make review MODEL=gpt-6.1-sol`.
9. **Merge.** When Quality is green:
   - Routine PR: `gh pr merge <pr> --merge --delete-branch`.
   - Auth, private media, migrations, deploy or infra: leave the merge to the
     owner and mark the queue line `[~]`.
10. **Close.** After a merge, close the issue with one line,
    `Shipped in #<pr>.`, and remove `doing`. Clean up any worktree you
    created.

## Finish

Reply with the queue table: issue, PR, status, and one line for each blocker.
Do not post evidence comments, screenshots or extra reports.
