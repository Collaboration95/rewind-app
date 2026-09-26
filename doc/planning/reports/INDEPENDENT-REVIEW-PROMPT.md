# Independent review request — remaining Sprint 2 Demo PRs

> Status update, 26 September 2026: all four audit PRs have merged into main. This request is retained as historical review context; no further approval of these PRs is needed. Current main is `6708066`, with passing Quality checks and CodeQL. Continue with the hosted and device acceptance gates.

PRs [#205](https://github.com/Collaboration95/rewind-app/pull/205) and [#206](https://github.com/Collaboration95/rewind-app/pull/206) have merged into main. Please review the two remaining PRs from your own non-author GitHub account:

1. [#204 — CI and security](https://github.com/Collaboration95/rewind-app/pull/204). It now targets main. Check that the current required quality gate, CodeQL, image scans and IaC gate pass, and that the five narrow IaC exceptions still expire on 10 October 2026. Look for a concrete missing gate or overly broad exception.
2. [#207 — performance and native UI](https://github.com/Collaboration95/rewind-app/pull/207). It now targets main. Check that Chat and Archive history are bounded, media snapshots preserve integrity, and the native keyboard/Archive changes make sense. Look for concrete data mixing or resource exhaustion.

Both branches were updated after their parent PRs merged. Their earlier approvals no longer satisfy the current review gate. Refresh each PR's **current head, base, diff, checks and review status** before approving. Keep the review practical: if CI is green, the change looks sound at a basic level, and there is no material defect, approve it. Do not block on style preferences, speculative edge cases or exhaustive reruns.

The current sprint covers only the synthetic Demo. Real accounts and remote/PWA reminders are next sprint. The corrected [Sprint 2 progress report](rewind-sprint-2-progress-report-2026-09-26.pdf) is review ready but says the sprint is not closed.

For an optional clean local check, use Node 22.23.3 from `.nvmrc`:

    git clone https://github.com/Collaboration95/rewind-app.git /tmp/rewind-independent-review
    cd /tmp/rewind-independent-review
    git fetch origin
    git switch --detach origin/codex/audit-devsecops  # or origin/codex/audit-performance
    npm ci
    npm run check

Current green GitHub checks are valid test evidence; rerun only what helps resolve a concrete concern. For each PR, give a short **PASS / REVISE / BLOCKED** decision with its head/base, CI status, what you checked and any actionable issue. Submit an approval only from your own account.

Code review does not close the hosted gates. Andrew reviews a **fresh exact** Terraform plan; Guruprasath owns any approved apply. Prior plan snapshots disagree, so do not use their counts as authority or widen the wake guard to absorb unrelated drift. Keep [#190](https://github.com/Collaboration95/rewind-app/issues/190), [#200](https://github.com/Collaboration95/rewind-app/issues/200), [#145](https://github.com/Collaboration95/rewind-app/issues/145) and [#203](https://github.com/Collaboration95/rewind-app/issues/203) open until actual lifecycle, origin, hosted journey and independent acceptance evidence is linked.
