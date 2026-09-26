# Rewind audit and sprint closure handoff — 26 September 2026

## Start here

The user asked to stop at the nearest complete increment and continue on a cheaper model. **Do not restart the audit or expand the feature scope.** Implementation is saved in four open PRs; the combined local checkout passes the complete quality gate. Finish review/merge and evidence collection, then close the Demo sprint only when its acceptance gates are actually satisfied.

The user's explicit scope decision is: **close the synthetic Demo sprint; real accounts and remote/PWA reminders belong to the next sprint.** Four of eight weeks have elapsed; use the remaining four weeks through **24 October** as the planning constraint. Team hours, confirmed roster, and a historical burndown were not supplied; do not invent them.

Read the accompanying sprint progress DOCX/PDF for the product-facing report. The initial audit is `doc/planning/audits/project-audit-2026-09-26.md`; this handoff supersedes its remediation status, not its historical findings. This document is the technical continuation guide. The separate closure checklist translates it into ordered actions.

## Boundaries and preserved work

- Repository: `/Users/speedpowermac/Documents/projects/CODE_MAIN/NUS/SWE5006/rewind-app`.
- Never inspect/extract/use parent `rewind-v1-source.zip`, archived `rewind-v1/`, or retired parent `src/`. The current repository's own `src/` is active.
- The original checkout is on `codex/sprint-label-reconciliation`. Its pre-existing modifications to `canvas/excalidraw/scene.excalidraw`, `doc/README.md`, and `infra/scripts/destroy-demo.sh` were preserved. Existing untracked audit/ideation/architecture files and the Word lock file were also preserved.
- New report/evidence files are under `doc/planning/reports/`. Do not stage unrelated original-checkout work.
- All application changes were developed in isolated worktrees sharing the original Git object store. Their `/tmp` paths may disappear after a reboot; the branch refs and pushed PR branches are the recovery source.
- Use in-thread subagents, not separate Codex tasks. The user authorized GPT-6 Sol Medium and GPT-6 Luna High. For the continuation, favor Sol Medium for bounded documentation/check triage; reserve Luna High for difficult correctness/security review. Do not change the main task's model without the user's choice.

## Saved branches and PRs

| Purpose                        | PR / branch                                                                                | Head at handoff                            | Local worktree                | Dependency                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------- | ------------------------------------------- |
| Release artifacts and images   | [#205](https://github.com/Collaboration95/rewind-app/pull/205), `codex/audit-release`      | `5a94537682b5505fd1092d9e638235185733568c` | `/tmp/rewind-fix-release`     | main                                        |
| Parallel CI and security       | [#204](https://github.com/Collaboration95/rewind-app/pull/204), `codex/audit-devsecops`    | `9e23ebe170720fa8c4c0012c2dd2c6a5fa98a71d` | `/tmp/rewind-fix-ci`          | stacked on #205 branch                      |
| Demo/client/server correctness | [#206](https://github.com/Collaboration95/rewind-app/pull/206), `codex/audit-server-fixes` | `481e5c47813470139e584c5c0a8fdf3af74c70f2` | `/tmp/rewind-fix-server`      | main                                        |
| Performance and native UI      | [#207](https://github.com/Collaboration95/rewind-app/pull/207), `codex/audit-performance`  | `240902afded13b6580281d0bc6d4467e72053b1d` | `/tmp/rewind-fix-performance` | stacked on #206 branch                      |
| Combined verified candidate    | local `codex/sprint-audit-fixes`                                                           | application code `c65a076`                 | `/tmp/rewind-fix-integration` | contains reviewed changes from all four PRs |

Main baseline was `525d3e539151b2f854a59d73c82b33e02f67d1cd`. None of these PRs was merged. Existing draft UI PR #201 and sprint-label PR #202 were left separate. Every new PR is attached to the original Codex task.

Recommended merge order: **205 → 204; 206 → 207.** Refresh each dependent branch against its merged base/main and rerun required checks. Main requires a non-author approval and up-to-date quality check; never bypass or impersonate that review. A CLEAN status on a feature-to-feature stacked PR does not establish approval to merge to main.

Final capture: **all four PRs are green at the exact heads above**, including all #204 security/image/IaC jobs. The durable snapshot is `2026-09-26-evidence/pr-checks-final.json`. This proves checks at capture, not non-author review or main acceptance; refresh GitHub before merging.

## What changed and why

### Correctness and Demo consistency (#206)

- Reveal calls preserve the runtime client's receiver; a class-backed regression catches detached-method failures.
- Native Chat now uses an XHR EventSource adapter: immediate LF framing, CRLF handling, replay cursor, teardown, per-line/event caps and 256 KiB response rotation.
- Group/invite/upload mutations revalidate the persisted Demo session inside the write transaction. Requests delayed during body reading cannot commit after revocation.
- The seeded quota/ledger now agrees: one three-second contribution. A real synthetic portrait MP4 with audio replaces contradictory ready metadata without a file. IDs, digest, duration and byte receipts agree.
- Fresh initialization creates the staging directory. Fresh migrate + consistency reports no findings; genuinely deleted media still produces an integrity finding after restart.
- Production E2E expects the valid seeded clip and proves the owner can download it, while another member cannot. It also checks the other member's own clip and shared film.

### Bounded resource use and native UI (#207)

- Initial chat/history pages are bounded at 100; archive and cycle pages at 50. Explicit older-page controls replace unlimited initial reads. Reactions are batched; unread reads metadata rather than full history. Chat uses FlatList and event-ID deduplication.
- Integrity cache: maximum 512 entries, 20-second TTL, expected digest plus file device/inode/size/mtime/ctime identity. Actual download serving still hashes and streams a private snapshot.
- Verified snapshots reserve at most 96 MiB across three requests, leaving headroom inside the production 128 MiB tmpfs. Oversized single media gets 413; exhausted capacity gets 429. Leases survive until streams close; growth beyond reserved size is rejected.
- Staged cleanup runs on a bounded cadence rather than every request.
- React state updaters are pure under replay. StrictMode regression retains exactly one message. A keyed archive surface prevents a pending old-session page from entering the next group/session.
- iOS KeyboardAvoidingView includes the top safe-area inset; Send was visually verified above the open keyboard and a synthetic `Hi` was sent and persisted. Archive download text is legible, current-cycle status distinguishes older released media, and ready archive content now uses ScrollView.
- Final archive scrolling is covered by the complete quality gate. A physical/manual swipe to the oldest entries remains a quick acceptance check: native AX scroll did not move the viewport, so no manual-swipe pass is claimed.

### Release reliability (#205)

- Release bundles require a clean checkout, exact `origin/main` SHA and successful main-push quality run. They bind both image IDs, revision labels, config-template digest/revision, schema version and checksums.
- Install/rollback promotes pointers only after health and actual running image IDs match. Compatible failures restore the prior artifact. Fresh wake has a prepare phase before restore/migrate/start and promotion.
- Runtime uses pinned Node 22.23.3 Alpine 3.24 with FFmpeg 8.1.2 and removes unused package managers. Web uses pinned Nginx 1.30.5 Alpine with patched libexpat, runs as `nginx`, listens on container port 8080, and preserves hosted host-port 80 mapping. Public/PWA assets are copied.
- Lifecycle guards accept only the intended distribution and related power-policy changes; unrelated IAM/Lambda updates remain rejected.
- Cost-audit Lambda packaging explicitly includes its two runtime Python modules and excludes local bytecode/tests. This fixed nondeterministic plan drift; it did not eliminate the need to review the resulting code update.

### CI, security and governance (#204 plus configured GitHub settings)

- Parallel jobs: static/root, server, frontend, browser with one export, cloud-free deployment fixtures; stable aggregate `Format, lint, typecheck, and test` requires every job to succeed.
- CodeQL JavaScript/TypeScript, Python and Actions scans. Candidate runtime/web images get Trivy scans and CycloneDX SBOMs. IaC retains full unfiltered findings and applies an exact exception policy.
- Five resource-specific IaC exceptions have owner Guruprasath and expiry **10 October 2026**: one human-only Terraform role S3 wildcard finding, and four KMS-preference findings across state/backups/audit/CloudTrail. Accepted Demo risk remains pending PR review. The gate rejects unknown high/critical findings, wrong/new resources, expired/duplicate/unused exceptions and missing results. No blanket CVE bypass.
- Main protection: stable quality check, strict up-to-date requirement, one approval, last-push approval, resolved conversations, enforced for admins, no force push/delete.
- Dependabot alerts/security updates enabled; secret scanning/push protection retained. `staging-demo` and `release` environments configured; release has Andrew as reviewer and prevents self-review. **No job yet uses the environment, so it does not enforce manual Terraform apply.**
- CodeQL vulnerability-result merge rules are **not yet active**: main needs baseline analysis after workflow merge. Activate appropriate security requirements after that baseline; avoid blocking bootstrap with missing contexts.
- Measured frontend statements ~78.31% against 70% gate; server V8 coverage is a separate measurement. npm production audit: zero high/critical, ten moderate advisory records; GitHub showed one unique moderate alert. No unsupported all-secure claim.

## Verification ledger and limits

| Evidence                                           | Result                           | Scope / qualification                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final `npm run check`, code `c65a076`              | PASS                             | Format, lint, architecture, typecheck; 31 root + 203 server + 357 frontend (40 suites) + 6 accessibility tests                                                                             |
| Responsive browser suite                           | 19 PASS                          | Before the last safe-area/ScrollView refinements; final a11y included in final gate                                                                                                        |
| Production-shaped E2E                              | 2 tests PASS twice consecutively | After seeded-clip assertion update, before final ScrollView-only refinement                                                                                                                |
| Complete Alpine/FFmpeg server suite                | 203 PASS                         | Read-only root, dropped capabilities, no-new-privileges, 768 MiB, 128 PIDs. Test harness alone allows `/tmp` executable wrappers and `/app/.local-data` tmpfs; production config unchanged |
| Fresh database diagnostics                         | No findings                      | Isolated `/tmp/rewind-native-fresh-diagnostics`; genuine corruption regression still passes                                                                                                |
| iPhone 15 Pro / iOS 17.5 / Expo Go 57.0.9          | Core synthetic journey PASS      | Quota/ledger match, native connection, unread clears, reconnect after abrupt runtime restart, owner advance/compile/release, archive entries, keyboard-visible Send and persisted message  |
| Patched image/IaC/CodeQL CI                        | PASS on #204 head                | Five exact IaC exceptions; available branch analyses had zero open CodeQL alerts                                                                                                           |
| Actual disposable Docker Compose                   | PASS                             | Both runtime/web healthy; `/api/health` and PWA manifest served through proxy; non-root `rewind` / `nginx`. Runtime lifecycle included migrate/seed/restart persistence/owner reset        |
| Live hosted HTTPS, rollback, independent human run | NOT RUN                          | AWS was not applied; no hosted acceptance inferred from fixtures                                                                                                                           |
| Physical Android APK / installed iPhone PWA camera | NOT RUN                          | Simulator synthetic media is not physical-camera proof                                                                                                                                     |

Screenshots are actual simulator captures, not mockups. They show only synthetic Demo content. `iphone-archive.png` was captured during the final UI review; `iphone-chat-keyboard.png` shows the corrected Send button above the keyboard. The report includes the same evidence with captions.

## AWS: exact stopping point, do not bypass

Read `/Users/speedpowermac/.codex/skills/rewind-aws-operations/SKILL.md` before AWS work. Human-reviewed plan/apply rules apply. Accepted owner decisions are already recorded (Sep 23, issue #142 comment 5788175900 / PR #184); do not reopen that settled decision or ask it again.

Read-only inventory found no Demo Lightsail instance/static IP in ap-southeast-1 and no distribution in us-east-1. **No AWS mutation, wake, apply, or paid resource creation occurred.**

The refreshed plan after deterministic Lambda packaging proposes **5 creates, 3 updates, 0 deletes**. Creates: Demo instance, public ports, static IP, attachment, distribution. Updates: cost-audit Lambda code hash, its scheduler policy (deferred ARN), and power-controller policy (new instance ARN). The generated ZIP was verified to contain exactly `cost_safety_audit.py` and `cost_safety_notification.py`.

Private local plan: `/tmp/rewind-sprint-final-demo.tfplan`; sanitized summary: `/tmp/rewind-sprint-final-demo-plan-summary.json`. Do not commit/upload raw plan, state, tfvars, credentials, or full AWS logs. The plan is a snapshot, not reusable approval after subsequent infra changes.

The wake guard correctly rejects the unrelated Lambda/scheduler-policy drift. **Do not broaden the allowlist just to pass.** Andrew reviews a refreshed exact plan; reconcile that drift separately through the existing human-owned process; Guruprasath is the apply owner. Then obtain a clean permitted wake plan and use the reviewed green release artifact. #200's origin-binding code is already on main (`cfb9dc7`, PR #188); only real distribution verification remains.

Indicative official pricing verified during this work: $7/month IPv4 micro plus $2.50/month 50 GB distribution = $9.50 base, before storage/logs/overages/tax. $10/$15 alerts are not hard caps. No claim of bounded maximum spend.

## Issue / board truth

Tracker #203 stays open; #207 was changed to `Refs #203` to prevent automatic closure. #145, #190 and #200 remain blocked on hosted/lifecycle evidence. #199 is Review/Test; #203 was In Progress at the snapshot. #142 is correctly closed; do not reopen it. Nine historically closed feature items were moved to Review/Test because independent acceptance was not established. Do not blanket-mark them Done based on test counts.

Project #8: `PVT_kwHOBBatWM4BiOxx`; status field `PVTSSF_lAHOBBatWM4BiOxxzhhHkx8`. Options: Review/Test `a56c51f7`, Blocked `d156edad`, In Progress `bb57d540`. Refresh actual metadata before changing anything. No remote reminders/OIDC work is required to close the current Demo sprint.

## Reproduce only what is needed

Use Node 22 rather than the host's Node 26. Existing portable toolchain: `/tmp/rewind-toolchain/node_modules/.bin` (may be ephemeral). Repository `.nvmrc` specifies 22.23.3. Dependencies are already installed in the worktrees; avoid unnecessary full reinstalls.

```sh
cd /tmp/rewind-fix-integration
export PATH=/tmp/rewind-toolchain/node_modules/.bin:$PATH
git status --short
git rev-parse HEAD
npm run check
# Only after changes affecting the relevant journeys:
npm run test:responsive
npm run test:production-e2e
```

Local-server/browser/Docker checks need loopback/network sandbox permission. An EPERM binding 127.0.0.1 inside the restricted sandbox is not an application failure; rerun that exact authorized check with escalation. Do not bypass security controls.

```sh
gh pr checks 205
gh pr checks 204
gh pr checks 206
gh pr checks 207
gh pr view 207 --json baseRefName,headRefOid,reviewDecision,mergeStateStatus
```

The combined branch contains cherry-picked equivalents, so do not blindly replay every source commit or cherry-pick merge commits. Compare diffs/patch IDs. Release `52278fe` and `5a94537` fixture fixes already have equivalents in integration via the CI branch. Superseded parallel follow-up patch `/tmp/rewind-performance-agent-superseded-followup.patch` is archival evidence only; **do not apply it over the final fixes**.

## Remaining work, ordered and bounded

1. Read the report and closure checklist; refresh final PR heads/checks. Triage only actual failures. Manual swipe-check the long native archive if continuing UI acceptance.
2. Obtain non-author review. Merge the four PRs in dependency order, refresh bases, rerun only required/affected checks, and ensure required main checks pass on the final commit.
3. Establish main CodeQL baseline and activate appropriate security-result requirements. Document which environment jobs actually consume protected environments before claiming deployment gating.
4. Andrew reviews the refreshed AWS plan and drift reconciliation. Guruprasath applies through the accepted process. Produce a verified release artifact from clean, green main.
5. Complete #190/#200/#145: two real HTTPS journeys, restart, denial/security-negative cases, rollback/fallback and genuine non-author run. Record physical APK/PWA acceptance as passed, failed, or explicitly unrun.
6. Reconcile Project statuses and write the short acceptance update. Close #203/current sprint only when the agreed gates pass or the user explicitly changes the acceptance contract.
7. Plan the remaining four weeks in parallel, with clear owners and interfaces: identity/onboarding; remote reminder delivery; client UX/physical-device acceptance; operations/security/reliability. Keep integration WIP small, PRs focused, and measure completed accepted work and cycle time rather than fabricated velocity.

## Evidence files and temporary context

Durable evidence is in `2026-09-26-evidence/` beside this handoff. Temporary detailed sources include `/tmp/rewind-handoff-final-check.log`, `/tmp/rewind-combined-container-server-final.log`, `/tmp/rewind-combined-production-e2e-final.log`, `/tmp/rewind-combined-responsive-final.log`, and `/tmp/rewind-sprint-report/` (builder, template fidelity evidence, rendered pages and QA log).

Isolated native data is `/tmp/rewind-native-audit-data`, never the original checkout's data. The final runtime used port 8787; Metro used 8081. Only those task-owned processes should be stopped during wind-down. Do not kill unrelated user processes or delete simulator state. The simulator itself may remain open for review.

## Wind-down record

All implementation agents were closed. Task-owned Metro (PID 18555) and local runtime (PID 88637) were stopped; the runtime needed forced termination after its open stream prevented graceful exit. Its data was disposable synthetic Demo data, preserved on disk. The simulator remains open. No scheduled automation was created. The tracker update is https://github.com/Collaboration95/rewind-app/issues/203#issuecomment-5842683502.
