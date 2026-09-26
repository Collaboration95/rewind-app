# Independent review request — Rewind Sprint 2 Demo

You are reviewing four PRs submitted by the Collaboration95 account. Please keep this review practical and proportional. Check that each PR does what it says, that its current required CI checks pass, and that the synthetic Demo works at a basic level. If it looks right and you find no concrete regression or material safety problem, **PASS and approve it**. Do not hold it for speculative edge cases, style preferences, exhaustive retesting, or features outside this sprint.

You must be a genuine non-author reviewer using your own GitHub account. The author cannot satisfy the required independent approval. The code approval is separate from Andrew's Terraform plan review and the later live hosted acceptance.

Read the audit handoff and closure checklist in this directory for context. The GitHub milestone is Sprint 2. The report is still named Sprint 1 and should be relabeled before external submission. This sprint covers the synthetic Demo. Real accounts and remote/PWA reminders are next sprint.

## Quick setup and tests

First refresh the current PR heads, bases, CI checks, comments and reviews. The September 26 evidence snapshot is historical. Use a clean clone or worktree if you run tests; the author's original checkout contains unrelated uncommitted work. Use Node 22.23.3 from .nvmrc and npm 10 or newer.

    git clone https://github.com/Collaboration95/rewind-app.git /tmp/rewind-independent-review
    cd /tmp/rewind-independent-review
    git fetch origin
    git switch --detach origin/codex/sprint-audit-fixes
    npm ci
    npm run check

The combined candidate previously passed 31 root, 203 server, 357 frontend and 6 accessibility tests. Current green GitHub checks on each PR are valid test evidence. You do **not** have to rerun every suite to approve. If you want a quick browser journey, run npm run test:production-e2e; if you want responsive UI checks, run npm run test:responsive. Install Playwright Chromium if your machine needs it. These tests use synthetic local data and do not deploy AWS.

If a specific part worries you, switch to its actual PR head and run only the relevant test: #206 is origin/codex/audit-server-fixes; #207 is origin/codex/audit-performance; #205 is origin/codex/audit-release; #204 is origin/codex/audit-devsecops. Useful focused commands are npm run test:production-e2e, bash tests/deploy/release-bundle.test.sh, npm run test:host-lifecycle (needs disposable Docker), and python3 -m unittest discover -s tests/security -p 'test_*.py'. Check the live CodeQL/image/IaC summaries for #204; open detailed artifacts only if a result needs explanation.

## Review these PRs

1. [#206 — Demo correctness](https://github.com/Collaboration95/rewind-app/pull/206): confirm Chat, reveal, seeded quota/media and basic owner/non-owner access align with the passing tests and simulator evidence. Focus on an obvious access or data-integrity regression.
2. [#207 — performance and native UI](https://github.com/Collaboration95/rewind-app/pull/207): confirm histories and media snapshots are bounded and the iOS keyboard/archive fixes make sense. Focus on obvious data mixing, integrity or resource-exhaustion mistakes. It is stacked on #206.
3. [#205 — release reliability](https://github.com/Collaboration95/rewind-app/pull/205): confirm a green main build produces the release bundle, health checks precede promotion, rollback is covered, and images are patched. Look for an obvious unsafe widening of the Terraform wake allowlist.
4. [#204 — CI and security](https://github.com/Collaboration95/rewind-app/pull/204): confirm the required quality, CodeQL, image and IaC checks are green. Note five narrowly defined IaC exceptions owned by Guruprasath and expiring 10 October 2026. Investigate a missing job, failing scan or broad exception. It is stacked on #205.

Review #205 and #206 against main; #204 against #205; #207 against #206. When a parent merges, verify its child now targets main, its diff remains focused, and required checks/approval still apply.

For each PR, give a short **PASS / REVISE / BLOCKED** decision with its current head/base, CI result, one or two things you checked and any concrete issue. If the basic behavior works and CI is green, approve it without extending the review unnecessarily. If there is a real defect, request the smallest fix and recheck it.

## Separate acceptance gates

Do not treat code approval as AWS or hosted acceptance. Andrew reviews a fresh exact Terraform plan; Guruprasath owns apply. The old sanitized snapshot showed five creates, three updates and zero deletes, including Lambda/policy drift rejected by the wake guard. Do not widen that guard just to make the plan pass. Do not circulate raw Terraform plans, state, tfvars, credentials or backups.

Keep #190, #200, #145 and the Sprint 2 tracker #203 open until real lifecycle, origin, two public HTTPS journeys, restart/denial/rollback and genuine non-author evidence is linked. Record physical Android APK and installed iPhone PWA status honestly. The simulator evidence is useful but does not claim physical-device or hosted acceptance.
