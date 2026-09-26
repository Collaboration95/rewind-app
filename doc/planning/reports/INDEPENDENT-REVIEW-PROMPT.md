# Independent review request — Rewind Sprint 2 Demo

You are a genuine non-author reviewer of changes submitted by the Collaboration95 GitHub account. Review the code and evidence yourself. A green CI run is supporting evidence, not a reason to approve without inspection. For each PR, return PASS, REVISE, or BLOCKED with the current head and base, checks, files inspected, tests or evidence checked, actionable findings with file and line, and any limitation. Submit a GitHub approval only from your own account after resolving findings. Do not use the author's account.

Read the audit handoff, closure checklist, initial audit, and verification evidence under doc/planning. The present GitHub milestone is Sprint 2. The report file is titled Sprint 1 and needs a label correction before external submission. Current sprint acceptance covers only the synthetic Demo; real accounts and remote/PWA reminders are next sprint.

First refresh GitHub's live PR heads, bases, checks, conversations, and review decisions. The September 26 snapshot in the evidence folder is historical. Review each diff against its actual base. PR #204 is stacked on #205; PR #207 is stacked on #206. After a parent merges, verify the child targets main, its diff stays focused, and required checks and approvals are current.

## Set up a clean test checkout

Use a new clone or worktree. Do not test from the author's original dirty checkout. Install the version in .nvmrc (Node 22.23.3, npm 10 or newer), Python 3, Docker if running the container lifecycle, and Playwright Chromium if the browser is missing. Never use real AWS credentials for local or CI fixtures. Run these commands from the repository root; replace the path with your own clean clone:

    git clone https://github.com/Collaboration95/rewind-app.git /tmp/rewind-independent-review
    cd /tmp/rewind-independent-review
    git fetch origin
    node --version
    npm ci

For a quick combined candidate smoke test, check out origin/codex/sprint-audit-fixes in detached mode and run:

    git switch --detach origin/codex/sprint-audit-fixes
    npm run check
    npm run test:responsive
    npm run test:production-e2e

The combined candidate passed 31 root, 203 server, 357 frontend and 6 accessibility tests in the required check; 19 responsive tests and the two-test production-shaped E2E also passed. Those counts are reference evidence for the historical head, not a substitute for recording your own result. The E2E uses synthetic local Demo data and a disposable local server. It does not deploy AWS.

For focused review, fetch and switch to the actual PR head before each test. For #206, use origin/codex/audit-server-fixes and run npm run check plus npm run test:production-e2e. For #207, use origin/codex/audit-performance and run npm run check, then verify the two state-safety regressions in tests/chat-screen.test.tsx and tests/archive-scope.test.tsx. For #205, use origin/codex/audit-release and run npm run check and bash tests/deploy/release-bundle.test.sh; npm run test:host-lifecycle requires a disposable local Docker environment. For #204, use origin/codex/audit-devsecops and run npm run check and python3 -m unittest discover -s tests/security -p test_*.py. Also inspect the GitHub CodeQL, image and IaC scan jobs, their retained artifacts, and the exact findings/exceptions. The CI result on each current PR head is the authoritative required gate.

To compare a stacked PR without pulling in its parent diff, use GitHub's Files changed view or compare the parent branch to the child head. Use main as base for #205 and #206, codex/audit-release for #204, and codex/audit-server-fixes for #207. If a parent has merged, refetch and inspect the new effective base/diff before reviewing or approving.

1. Review https://github.com/Collaboration95/rewind-app/pull/205 — release artifacts. Trace clean origin/main and green-main-run provenance, both image IDs, config and schema checksums, health-gated promotion, failed load or health check, compatible rollback, and verified wake inputs. Check the patched runtime and web images, non-root web port 8080, PWA assets and cloud-free lifecycle evidence. Reject any broadening of the Terraform wake allowlist merely to absorb unrelated Lambda or IAM drift.
2. Review https://github.com/Collaboration95/rewind-app/pull/204 — CI and security. Check that all parallel static, server, frontend, browser and deployment jobs must succeed for the required aggregate gate. Verify CodeQL for JavaScript/TypeScript, Python and Actions; both image scans, SBOMs and npm audit threshold. Inspect the full IaC output and negative gate tests. Five exact resource-specific IaC exceptions are owned by Guruprasath and expire 10 October 2026; confirm unknown, new, duplicate, unused and expired findings fail. Residual exceptions remain risks. CodeQL result merge requirements need a baseline on main, and the configured release environment is not yet a Terraform-apply gate because no job uses it.
3. Review https://github.com/Collaboration95/rewind-app/pull/206 — Demo correctness. Check the reveal-client receiver and class-backed regression; native XHR EventSource LF/CRLF, replay, bounds, reconnect and teardown; persisted-session revalidation inside group, invite and upload write transactions; the three-second seeded MP4, quota, digest and output paths; fresh database consistency and genuine missing-output detection. Confirm production E2E owner and non-owner clip access. Native simulator evidence does not prove physical camera or hosted behavior.
4. Review https://github.com/Collaboration95/rewind-app/pull/207 — paging, media bounds and native UI. Check stable cursors, bounded history/archive pages, reaction batching and unread metadata; archive cache identity and digest; private download snapshots; the 96 MiB and three-request budget within a 128 MiB tmpfs, 413/429 responses and lease release; React StrictMode duplicate/replay and old-session archive-page regressions. Check Send above the iOS keyboard, archive contrast and current-cycle explanation. Manual swipe to the oldest archive entries remains an open acceptance check.

Keep infrastructure and hosted acceptance separate from code review. Andrew must review a fresh exact Terraform plan after code changes; Guruprasath owns apply. The September 26 sanitized plan showed five creates, three updates and no deletes, including unrelated Lambda/scheduler-policy drift rejected by the wake guard. Do not circulate the private raw plan, state, tfvars, credentials or backups. No AWS apply occurred in the audit.

Do not close #190, #200 or #145 on code evidence alone. They require actual lifecycle and origin verification, two public HTTPS journeys, restart, denial, rollback or fallback, and a genuine non-author run. Record physical Android APK and installed iPhone PWA status honestly. Keep #203 and Sprint 2 open until the agreed acceptance evidence is linked. Never bypass branch protection or count the author as the independent reviewer.
