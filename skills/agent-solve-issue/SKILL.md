---
name: agent-solve-issue
description: Understand, discuss, implement, test, and prepare a GitHub issue or related issue group in the current coding session, recording user decisions and implementation evidence for auditability.
metadata:
  short-description: Guided issue solving with decision records
  compatibility: "Codex, Claude Code, and OpenCode"
---

# Guided issue solving

Use this skill when the user explicitly asks to inspect, walk through, ideate
about, or solve a GitHub issue or a coherent group of related issues. It is
designed to continue inside the current coding session; do not require a new
session, `/clear`, or `/compact`.

Accepted request shapes include:

```text
/agent-solve-issue https://github.com/OWNER/REPO/issues/123
/agent-solve-issue #123 — walk me through it
/agent-solve-issue solve #123 and #124 as one logical change-set
```

If the user gives only an issue reference without saying whether to walk
through or implement it, inspect the issue and ask whether they want a
walkthrough or implementation before changing files.

## Operating modes

- **Walkthrough:** inspect context, explain the problem, identify decisions,
  and ask questions. Do not modify code or open a PR.
- **Solve:** perform the complete workflow below, including implementation,
  tests, PR preparation, and GitHub issue records.
- **Continue:** resume the existing issue-solving session from the current
  context, working tree, decision record, and issue comments. Do not restart
  discovery that has already been completed.

Use the user's explicit wording to select the mode. When the request is
ambiguous, ask one concise question instead of guessing.

## Core principles

- Work from the repository's actual current state, not from issue prose alone.
- Treat the issue as the source of product intent, acceptance criteria, and
  exclusions. Do not silently expand its scope.
- A branch/PR may contain multiple issues when they form one coherent,
  independently explainable change-set. Preserve separate acceptance checks and
  traceability for every issue.
- Prefer codebase evidence over questions. Ask the user only for choices the
  repository and issue cannot resolve.
- Ask material questions one at a time, in a `grill-me` style: explain the
  decision, give a recommended answer, and state what changes if the other
  answer is chosen.
- Record confirmed facts, user opinions, decisions, assumptions, risks, and
  open questions separately. Do not turn an agent assumption into a user
  decision.
- Preserve unrelated working-tree changes. Stop before editing if the current
  branch or dirty files overlap the intended change and the safe boundary is
  unclear.

## Phase 1 — Resolve context

Before ideation or implementation:

1. Parse the issue number or URL. Confirm the repository and issue state.
2. Read repository instructions such as `AGENTS.md`, `CONTRIBUTING.md`, and
   applicable skill or workflow files.
3. Read the complete issue, comments, linked issues, parent/sub-issues,
   blockers, related pull requests, labels, milestone, and Project status.
4. Inspect the current branch, working-tree state, remotes, default branch,
   recent commits, relevant files, tests, manifests, CI, and existing patterns.
5. Trace the issue to concrete code or documentation boundaries. If the issue
   is not implementable from the current repository, explain the gap before
   proposing a solution.
6. Summarize the current context for the user:

   - what the system does today;
   - what the issue is asking for;
   - why it matters;
   - likely files and boundaries;
   - dependencies and likely roadblocks;
   - what is explicitly out of scope;
   - the proposed issue grouping, if more than one issue was supplied.

Do not implement during this phase.

## Phase 2 — Ideate and grill decisions

Build a decision inventory from the issue and codebase. Include product,
behaviour, UX/UI, platform, architecture, API/path, data, privacy/security,
dependency, test, and evidence choices whenever they could materially change
the implementation.

For each unresolved material decision:

1. Explain the choice in plain language.
2. Recommend the option that best preserves the issue, project plan, current
   architecture, and smallest verifiable change.
3. Ask exactly one question.
4. Wait for the user's answer before asking the next decision.
5. Record the answer as a user decision, including any rationale or constraints
   the user gives.

Do not ask questions that can be answered by inspecting the codebase. Do not
interrogate the user about trivial naming or formatting choices; use repository
conventions for those.

Typical questions include:

- Which supported platform or device should be treated as authoritative?
- Which UI concept, interaction, copy, empty state, or accessibility behaviour
  should be used?
- Should two related issues land atomically, or should the first be independently
  mergeable?
- Which API/data boundary is intended when multiple valid paths exist?
- Is a compatibility or migration path required?
- Which behaviour is preferred when the issue and current code disagree?

If the decision changes scope, privacy, security, architecture, public API, or
the verification strategy, stop and obtain an explicit answer. If a decision
cannot be answered by the user, record it as blocked rather than hiding it in
an implementation assumption.

## Phase 3 — Record the session before coding

For Solve mode, publish a decision/context record to the primary issue before
implementation begins. If the user has not authorized issue comments for the
current invocation, prepare the exact comment and ask before publishing it.

For a grouped change-set, choose one primary issue and link the secondary
issues. Add a short traceability comment to each secondary issue rather than
duplicating the entire record.

Use this structure:

```md
## Agent issue-solving record

### Session goal

<humanised outcome>

### Issues in this change-set

- #123 — <outcome>
- #124 — <outcome>

### Confirmed facts

- <facts established from the repository or user>

### User decisions

- <decision> — rationale: <why>

### Assumptions

- <agent assumption, clearly marked>

### Scope and exclusions

- Included: <scope>
- Excluded: <scope>

### Expected challenges and risks

- <risk and response>

### Implementation plan

- <short ordered plan>

### Verification plan

- <tests, manual checks, accessibility/security checks, and evidence>
```

Never include credentials, tokens, private media, personal data, or sensitive
local paths in an issue comment. Redact them and record only the relevant fact.

## Phase 4 — Select or create the working branch

Inspect the existing branch before creating one.

- If the current branch is already the agreed issue-group branch, continue on
  it.
- If it contains aligned uncommitted work, preserve it and ask before making
  overlapping edits.
- If the current branch is `main` or unrelated, create a short-lived branch
  from the latest agreed base branch.
- Use the repository's actual default/base branch. For `rewind-app` today this
  is `main`; do not invent `dev/main`.
- Use a name describing the logical change-set, such as
  `chore/issue-3-4-delivery-foundation`.

Before branching, use the equivalent of:

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
git switch -c <change-set-branch>
```

Do not force-push or rewrite a shared branch. If the user supplies a different
base branch, verify that it exists and follow that explicit choice.

## Phase 5 — Implement the change-set

Implement only the agreed scope. Keep commits understandable, and reference
the relevant issue number(s). It is acceptable to have multiple commits in one
PR, for example one commit per issue, when that makes review easier.

During implementation:

- preserve existing conventions and interfaces unless a recorded decision says
  otherwise;
- add UI, domain, data, and test changes as one behaviourally complete slice;
- do not hide unfinished behaviour behind misleading success states;
- update documentation or architecture records when behaviour or boundaries
  change;
- keep synthetic demo data and privacy boundaries explicit where applicable;
- surface new decisions to the user before committing to them;
- pause and ask if a blocker materially changes the issue or proposed plan.

## Phase 6 — Verify acceptance and quality

Before opening a PR, perform all applicable checks:

1. Walk every linked issue's acceptance criterion and mark the evidence.
2. Confirm explicit exclusions were not implemented accidentally.
3. Exercise the happy path and meaningful failure, empty, loading, retry,
   denied, and boundary states.
4. Add or update focused tests for changed behaviour and negative paths.
5. Run documented formatting, lint, type-check, unit-test, build, and startup
   checks where applicable.
6. For UI, check accessible names, focus/keyboard behaviour where supported,
   larger text, contrast, selected states, and non-colour-only communication.
7. Check security, privacy, secrets, permissions, dependency changes, and
   accidental generated/private files.
8. Capture synthetic screenshots or other evidence required by the issue.

Report commands exactly. Never claim a check passed if it was not run.

## Phase 7 — Synchronize and prepare the PR

Before opening or marking the PR ready:

1. Fetch the latest base branch.
2. Update the feature branch from that base using the repository policy. A
   normal merge is preferred for this student project because it avoids force
   pushes; rebase is allowed only on a private branch.
3. Resolve conflicts on the feature branch, never by directly pushing a fix to
   `main` or `dev`.
4. Rerun the relevant checks after conflict resolution.
5. Create or update the PR using `.github/pull_request_template.md`.
6. Link every issue accurately: use `Resolves #123` only when the PR fully
   satisfies that issue; use `Refs #123` for partial or follow-up work.
7. Run GitHub Actions and wait for required checks.

For a grouped PR, the description must explain why the issues belong together,
list each issue separately, and show acceptance evidence separately. Do not use
grouping as a reason to hide unrelated work.

## Phase 8 — Agent review and human review

After the final PR diff and automated checks are available, invoke the shared
review skill with the PR URL:

```text
$agent-review-pr-link <PR_URL>
```

The agent review must be published on the PR using the standard format. It is
not a human approval and must not merge the PR.

Then ask a different team member to review. The human reviewer should run the
code, verify the acceptance criteria and evidence, inspect the agent findings,
and approve only when the change is ready. If the reviewer requests changes,
return to implementation, rerun checks, and repeat the agent review if the
final diff materially changed.

## Phase 9 — Close the audit loop

After implementation and PR preparation, publish an implementation summary to
the primary issue. For grouped work, add a short linked summary to secondary
issues.

```md
## Agent implementation summary

### Issues

- #123 — completed/partial: <status>
- #124 — completed/partial: <status>

### Decisions applied

- <decision and resulting behaviour>

### Changes

- <observable change and important files/boundaries>

### Acceptance evidence

- [x] <criterion> — <evidence>
- [ ] <criterion> — <reason, follow-up issue, or blocker>

### Checks run

- `<command>` — passed/failed/not run

### PR and review

- PR: <link>
- Agent review: <link or comment reference>
- Human reviewer: <person or pending>

### Residual risks and follow-up

- <items, or `None`>
```

Do not mark an issue Done until the PR is merged and its acceptance criteria
are verified. Do not close a parent issue while required child issues remain
unfinished. If the work is blocked, record the exact blocker and leave it
open/blocked rather than presenting partial work as complete.

## Stop conditions

Stop and ask the user when:

- the issue reference or repository is ambiguous;
- current uncommitted work overlaps the change and cannot be safely separated;
- a product, UI, platform, privacy, security, API, or architecture decision is
  unresolved;
- the issue acceptance criteria conflict with the codebase or another issue;
- required credentials, external access, or a human reviewer are unavailable;
- tests fail and the failure cannot be explained or safely fixed within scope;
- completing the issue would require unrelated cleanup or a new issue.
