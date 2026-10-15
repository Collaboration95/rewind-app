# Delivery and verification

Source baseline: `dev` commit `40ebeb5673d103b4b6950d095192aae744980769`,
checked against the authenticated remote on 15 October 2026. Workflow behavior
below describes that revision, not a claim that a deployment ran today.
Branch protection was read on the same date. The root working agreement takes
precedence over older planning and runbook acceptance requirements.

See [current system](current-system.md) for the application architecture and
[deployment runbook](../../deploy/README.md) for operating procedures.

## Source control and developer access

`Collaboration95/rewind-app` is the authoritative repository. `App.tsx` and
`src/` contain the client; `server/src/` the server; `tests/` and `server/tests/`
the regression suites; `deploy/` host packaging and recovery; `infra/terraform/`
the infrastructure definitions; `.github/workflows/` the automation. These
paths are relative to this repository, not its retired parent workspace.

Start focused issue branches from current `dev` and open PRs back to `dev`.
Use separate worktrees for parallel work. Reference the issue without closing
keywords, merge after the delivery conditions, then close it with the PR link.
Milestones track Sprints; `mvp` tracks active scope; `doing` tracks current
work. Project boards are not maintained. Archived issues are outside scope.

The live branch protections require an up-to-date
**Format, lint, typecheck, and test** check, resolved conversations and PRs on
both branches; administrators are included and force pushes are disabled.
`dev` requires zero approving reviews. `main` requires one approving review
and approval of the last push. Routine dev PRs need no human approval;
authentication, private media, database migration, deployment and infrastructure
merges stay with the owner. Batched work has one review-agent pass per PR and
blocking findings must be fixed. A small green dev diff reaches release through
a reviewed PR to `main`. Urgent main fixes return to dev through a PR.

Use authenticated `gh` for GitHub access. This developer credential is separate
from product sign-in. Web/PWA release sign-in uses Cognito Managed Login,
authorization code + PKCE and server-side exchange, with a pool per environment.
Local runs, tests and hosted dev retain **Developer sign-in**, controlled by
`REWIND_AUTH_PASSWORD`; release disables the password form. Native Expo is a
local/dev testing path; compiled native iOS is outside delivery scope.
See [Cognito decisions](../../doc/planning/sprints/sprint-3-cognito/design-decisions.md).
Never commit credentials, settings objects, Terraform state or private plans.

## Quality workflow and merge gate

[quality.yml](../../.github/workflows/quality.yml) runs on pushes to `dev` and
`main`, and PR events `opened`, `synchronize`, `reopened`, `ready_for_review`
without a base-branch filter. Feature-branch pushes alone do not duplicate PR
runs. Concurrency is per PR number or ref and cancels the previous run.
All jobs use Ubuntu 24.04 and the configured Node version from `.nvmrc`.

| Job ID            | Display name / work                                                                                                   | Condition after `changes`                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `changes`         | Classify change scope using the exact base/head trees                                                                 | Always                                         |
| `checks`          | Static check matrix: `format:check`, `lint`, `architecture:check`, `typecheck`                                        | Non-docs                                       |
| `audit`           | Production dependency audit: `npm audit --omit=dev --audit-level=high`                                                | Non-docs                                       |
| `static`          | Root and IaC tests: `test:root`, Python IaC gate failure fixtures; installs Chromium/FFmpeg                           | Non-docs                                       |
| `server`          | Build, SQLite server suite and V8 coverage                                                                            | Non-docs                                       |
| `server-postgres` | Server suite against isolated PostgreSQL 17 service                                                                   | Non-docs                                       |
| `frontend`        | Jest with coverage and global statement threshold                                                                     | Non-docs                                       |
| `browser`         | Export once, PWA check, full configured Playwright suite                                                              | Non-docs and push to main or PR targeting main |
| `fixtures`        | Cloud-free backup, recovery selection, lifecycle, restore, ownership, preflight, bootstrap and release shell fixtures | Non-docs                                       |
| `gate`            | **Format, lint, typecheck, and test**                                                                                 | `always()`, including failures/skips           |

The gate requires classification success. For non-docs it requires all listed
non-browser jobs to succeed and additionally requires browser success on main.
The four static matrix legs must all pass. On dev, browser is deliberately
outside that gate; green dev Quality alone does not prove export, accessibility
or responsive behavior.

[The classifier](../../scripts/classify-quality-changes.mjs) treats only regular
mode `100644` Markdown as documentation: root `.md` files, files under `docs/`,
`doc/`, `skills/`, and immediate `.github/*.md`. Both sides of a rename/deletion
are checked. Executable files, symlinks, non-Markdown files, missing comparison
commits and empty comparisons fall back to all checks. A docs-only run skips
all eight downstream check groups; the gate verifies those skips and reports
success with **no application tests run**. This path also skips automatic host
deployment. It does not run a Markdown format or link check, so perform those
checks locally for the changed document.

## Deployment and operational workflows

[Deploy dev](../../.github/workflows/deploy-dev.yml) triggers on dev pushes or
manual dispatch, uses environment `dev` and serializes in `deploy-demo-dev`
without cancelling an active deploy. [Deploy release](../../.github/workflows/deploy-release.yml)
triggers on main pushes or manual dispatch, uses environment `release` and
serializes in `deploy-release`. Both classify docs-only changes before the
`deploy` job. Manual dispatch has no push comparison base, so classification
fails safe to a deploy attempt; it is not a way to bypass Quality.

For an executable change, each deployment checks the event SHA and waits for
that SHA's successful **push** Quality workflow on its own branch (up to 1,500
seconds, checking every 20 seconds). Failure/cancellation or expiry refuses
deployment. These are push-triggered workflows that currently wait internally,
not `workflow_run` triggers. Open issue #497 must not be described as delivered.

The job builds and verifies a revision/configuration-bound bundle with
`deploy/release.py`, assumes the environment's deploy role through GitHub OIDC,
requires an already running host, opens runner-specific temporary SSH, installs
the bundle and checks public health. Host install health checks restore the
previous release on activation failure. The public health probe is a further
check; it does not establish every product journey. The job cleans temporary
SSH/key material. It does not power the host on. Historical `demo` resource and
variable names continue to identify hosted dev; the synthetic Demo is removed.

Main's approval is the release review boundary. Workflow source declares the
environments and role usage, but does not itself prove live environment settings,
provisioning, deployment completion or device acceptance. A normal executable
merge to dev automatically attempts deployment after Quality; docs-only merges
skip it. Deployment is not an additional issue acceptance gate.

Two existing manually dispatched workflows have separate scopes:

- [Database operations](../../.github/workflows/database-operations.yml): `operate`
  only on dev, environment `dev`, shared dev-deploy concurrency; operations
  `status`, `bootstrap`, `import`, `resume`, `backup`, `rehearse-restore`.
- [Reviewed media Terraform](../../.github/workflows/terraform-environments.yml):
  `media` only for dev/ref dev or prod/ref main, `plan` or `apply`, environment
  `terraform-<environment>-<operation>`. Preflight checks protections and a
  green head before AWS credentials. Apply validates the reviewed plan run,
  hashes and private S3 metadata version. No PR trigger exposes state credentials.
  See [environment procedure](../../infra/terraform/environments/README.md).

## Verification boundaries

`npm run test:fast` aliases `npm test`: build the server once, then run root,
server and Jest suites concurrently with CPU caps. It does not collect coverage,
run the separate PostgreSQL service suite, export the web app, or execute the
full responsive/real-account browser journeys. “Fast” is not “browser-free”:
root HTTP transfer integration can use Chromium, and media tests need FFmpeg.
[Root discovery](../../scripts/run-root-tests.mjs) now includes `scripts/*.test.mjs`
and nested deployment, Terraform and real-account fixture tests; native-build
fixtures remain separate. The benchmark contract tests are discovered there,
but the actual timed benchmark workload is not automatically executed.

| Change / purpose                                                | Cheapest appropriate verification                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Styling, copy, layout                                           | `npm run web`, inspect in browser                                                                                |
| Client logic                                                    | One focused test, then `npm run test:fast`                                                                       |
| Server logic                                                    | Local server + SQLite, exercise in browser and focused server test, then fast suite                              |
| Real-account flow                                               | `make run-real`, `http://localhost:8090`, 10-minute cycles; `make run` currently aliases this target             |
| iPhone camera, install, web push, S3, Cognito                   | HTTPS hosted dev after normal deploy; local fixtures do not establish these integrations                         |
| Export, routing, PWA, accessibility changes; any main promotion | `npm run test:slow`, coverage, and `npm run test:a11y`                                                           |
| Pure documentation                                              | Source/link/format inspection; docs-only CI does not replace the shared unchanged-application fast-test baseline |

Use the existing focused runner, for example
`npm run test:focused -- server server/tests/cycles.test.mjs`. Limit focused
diagnosis to two attempts per issue; record a blocker rather than weakening
assertions. `test:slow` exports, checks PWA assets, runs Playwright and then the
real-account end-to-end runner. `test:a11y` rebuilds and runs the configured
accessibility spec. Automated axe/browser checks cover their selected pages and
fixtures; they do not prove universal accessibility or physical-device behavior.

Frontend coverage includes `App.tsx` and `src/**/*.{ts,tsx}` excluding declaration
files. [Jest](../../jest.config.cjs) enforces **70% global statements**; branch,
function and line coverage are reported without separate thresholds. Server V8
coverage covers built `server/dist/**/*.js` and has no numeric threshold in
Quality. Frontend summary and server summary/raw V8 artifacts retain 14 days.
Do not combine SQLite/PostgreSQL suite counts into a unique-test total.

## Security checks and their limits

The production dependency audit is inside aggregate Quality. The following
existing workflows are separate; branch protection inspected on 15 October
requires the aggregate Quality context, not these individual job names:

- [CodeQL](../../.github/workflows/codeql.yml): pushes to main/dev, PRs, and
  Mondays at `03:23 UTC`; `changes` classifies scope, then `analyze` runs
  `security-extended` for JavaScript/TypeScript, Python and Actions unless docs-only.
- [Release security](../../.github/workflows/release-security.yml): PR path
  filters `.github/workflows/**`, `.github/iac-scan-exceptions.json`,
  `scripts/check-iac-scan.py`, `app.json`, `App.tsx`, package/lock files,
  `public/**`, `src/**`, `server/**`, `deploy/**`, `infra/**`; tags `v*`; manual
  dispatch. `images` builds runtime/web candidates, records commit/image identity,
  generates CycloneDX SBOMs and fails on HIGH/CRITICAL image vulnerabilities.
  `iac` retains configuration findings and runs the exact-finding gate with
  expiring decisions. Scan artifacts retain 30 days.

Passing scans are evidence for those tools and inputs, not an independent
security audit or proof of no vulnerabilities. A docs-only PR need not trigger
Release security. Third-party checks seen in historical runs do not establish
an additional repository-owned workflow or a current mandatory gate.

## Dated evidence index

These are recorded observations, not new executions for this documentation PR.
The current unchanged-application fast-test baseline is coordinated separately
by the submission batch; no current pass is inferred from older results.

| Date / source                                                                                                                                                                                                                       | Recorded result and boundary                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 October 2026, [Quality run 37887860231](https://github.com/Collaboration95/rewind-app/actions/runs/37887860231), SHA `7bab4027bd4b19425fd4bfbe8e9a0d99d2f2a913`                                                                   | Root 167 passed / 1 skipped plus 6 Python tests; SQLite 469 passed / 8 skipped; PostgreSQL 443 passed / 34 skipped; Jest 53 suites / 568 tests. Dev browser job skipped.                                                                                                                                                        |
| Same Quality log                                                                                                                                                                                                                    | Frontend statements 75.55%, branches 72.99%, functions 72.58%, lines 78.88%; server statements 89.06%, branches 83.94%, functions 88.47%. Historical log values, not a current coverage run.                                                                                                                                    |
| 10 October snapshot, saved `quality-analysis.txt`                                                                                                                                                                                   | 610 Quality attempts: 497 success, 65 failure, 48 cancelled. 84 dev push deploy attempts: 71 success, 13 failure. Window starts 27 September 00:00 SGT and ends at collection 10 October 20:39:12 SGT; includes retries/cancellations, not unique PR or test pass rates.                                                        |
| Same snapshot, [dev deployment 37887860203](https://github.com/Collaboration95/rewind-app/actions/runs/37887860203)                                                                                                                 | Recorded success on the same `7bab4027…` revision. Does not establish today's deployed revision or device acceptance.                                                                                                                                                                                                           |
| 7 October, [PostgreSQL recovery](postgresql-operations.md#recovery), [PR #508](https://github.com/Collaboration95/rewind-app/pull/508)                                                                                              | Reported PITR RPO 334 s, RTO 1,022 s, 38 tables / 889 rows reconciled. A historical rehearsal, not an availability SLA or zero-loss guarantee.                                                                                                                                                                                  |
| 12 October, [720p local benchmark](../../doc/planning/performance/353-local-measurement.md#current-code-measurement--12-october-2026-526-local-sqlite-not-hosted), [#526](https://github.com/Collaboration95/rewind-app/issues/526) | Base `a1dc77e940a824b0d4e9ffaabf1e4ac517e38816` plus documented runner patch/hash; three SQLite/disk/loopback repetitions, five clients, 30 s warm-up, 1,200 measured API requests; p95 4.307–9.668 ms, zero errors. 25 six-second clips per film; end-to-end 4.964 / 5.700 / 9.031 s, 720×1280 at 30 fps, 150.4 s, −17.4 LUFS. |

The benchmark met its local API p95 ≤2 s (excluding IdP) and film ≤10 min targets.
Generated 1080p portrait/landscape individual clips retained dimensions/audio;
films used the existing 720p composition contract. It used synthetic media on a
contended developer Mac, no hosted PostgreSQL/S3/IdP/network/device path. The
12 October record supersedes the 3 October 180×320 film timings for the current
film contract. The guide's recorded SGT/UTC clock conversion is inconsistent;
use its date, revision, patch hash and durations rather than infer an exact UTC
execution time.

Saved evidence provenance: repository-local
`.local-data/sprint-prep-20261011/sprint-2-working-files/evidence/quality-analysis.txt`
and `metrics.json`. These are untracked historical inputs, not portable links.
The metrics census was collected across 10 October 20:39–20:44 SGT, with final
cutoff 20:44:32 SGT; it is not atomic and Sprint 2 had not ended. Current labels,
milestones, closures and merges do not establish immutable commitments, deployed
behavior, member ownership or hours. Public run/PR links and repository runbooks
above provide reusable references without publishing the local evidence store.

## Recovery and performance references

Use [PostgreSQL reverse export and database-only switch](postgresql-operations.md#reverse-export-and-database-only-switch),
delivered with [#505](https://github.com/Collaboration95/rewind-app/issues/505),
when returning to SQLite while preserving post-cutover writes. Quiesce all
writers, export a consistent readable PostgreSQL snapshot, reconcile rows/hashes,
and install with the guarded database-only swap. Keep current media and S3
references. Do not use a full media restore to install only the database. If
PostgreSQL is unreadable, recover a managed/logical backup and report its actual
recovery point; the old SQLite snapshot cannot preserve later writes.

Application rollback and host rebuild are in the [deployment runbook](../../deploy/README.md#host-rebuild-and-recovery).
Database round-trip reductions are in [ADR-0003](ADR-0003-postgresql.md), distinct
from wall-clock performance. [Operational signals](../../doc/planning/operations/operational-signals.md)
describes redacted failure logs and database-backed job/reminder/transition
records; those operator read paths are not a paging or dashboard guarantee.
