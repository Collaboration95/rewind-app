# Post-merge security and release readiness

**Checked:** 2026-09-26 (UTC)
**Repository:** `Collaboration95/rewind-app`
**Main commit:** [`67080662af3b1969c0da3129641d0ac24d097395`](https://github.com/Collaboration95/rewind-app/commit/67080662af3b1969c0da3129641d0ac24d097395)

## Verified on main

- Main points to `6708066`, the merge of PR #207. The main-branch [Quality checks run](https://github.com/Collaboration95/rewind-app/actions/runs/36232142461) and [CodeQL run](https://github.com/Collaboration95/rewind-app/actions/runs/36232142441) completed successfully.
- `.github/workflows/quality.yml` has a stable aggregate required-check candidate named **Format, lint, typecheck, and test**. It waits for static/root, server, frontend, browser, and deployment-fixture jobs. The workflow also performs a production dependency audit with high severity as its failure threshold.
- `.github/workflows/codeql.yml` analyzes JavaScript/TypeScript, Python, and GitHub Actions using `security-extended`; it runs on main pushes, pull requests, and a weekly schedule. The successful main run confirms analysis ran. It does **not** prove the current alert baseline is empty.
- `.github/dependabot.yml` schedules weekly updates for npm, GitHub Actions, and Docker.
- GitHub search currently returns at least ten open Dependabot PRs (#209–#218), including major-version updates to Node, CodeQL Action, React DOM, Expo Video, ESLint, setup-node, upload-artifact, and Nginx. They are open update PRs; this search does not establish whether each corresponds to a security advisory.
- The `release-security` workflow defines runtime and web image builds, CycloneDX SBOMs, HIGH/CRITICAL Trivy scans, and an IaC scan artifact. It runs for relevant pull requests, `v*` tags, or manual dispatch. A successful Node 26 Dependabot PR run (36232000177) retained runtime, web, and IaC scan artifacts with SHA-256 artifact digests and a 30-day expiry. The coordinating run also dispatched [Release security on exact main `6708066`](https://github.com/Collaboration95/rewind-app/actions/runs/36235689193): runtime image, web image, and IaC jobs all passed, and all three artifacts were retained. This is a scan/evidence bundle, not a deployment or published release.

## Unverified or incomplete

- **Current CodeQL alert baseline:** the coordinating run used authorized read-only GitHub API access and found **17 open CodeQL alerts** on main at first read: two error-level findings in release/proxy code, two warning-level findings in production code, and thirteen warning-level findings in test code. The thirteen test-only alerts were then individually dismissed as `used in tests` with explanations; **four production alerts remain open** (#1–#4). A successful CodeQL workflow run is not a security clearance.
- **Current Dependabot alert on main:** the coordinating read-only API query found **one open moderate alert**, for `uuid` buffer bounds in v3/v5/v6. A fresh `npm audit --omit=dev --json` on merged main reported 10 moderate affected packages, including transitive Expo tooling, with zero high or critical findings. The combined candidate fixes this: its clean install and production audit report zero vulnerabilities. Main's alert remains until the fix is merged and rescanned.
- **Required-check enforcement:** a fresh authorized branch-protection read confirmed the required `Format, lint, typecheck, and test` context, one approving review and admin enforcement. Main Quality and CodeQL runs passed. CodeQL vulnerability-result merge requirements were not confirmed as active.
- **Release artifact:** no GitHub Release is published. The release-security workflow builds and scans candidate images and retains SBOM/scan/identity evidence; it does not publish the container images to a registry or produce a user-downloadable application bundle. The latest main push ran Quality and CodeQL, not a `v*` release-security event. A tagged/manual release run against this exact green main commit remains to be performed and reviewed.

## Next work

Automated progress: [combined PR #224](https://github.com/Collaboration95/rewind-app/pull/224), head `c58d27a5f75a73d6143acab6c616e682ade41a40`, contains fixes for production CodeQL alerts #1–#4 and a tested `uuid@11.1.1` override. Its required Quality check, three CodeQL analyses, three release-security scan jobs, and GitGuardian check all passed. The combined merge ref has zero open CodeQL alerts across those analyses. Locally, `npm run check`, two production E2E runs, release-bundle tests, clean `npm ci`, and `npm audit --omit=dev` passed; the audit found zero vulnerabilities. Branch protection still requires an independent approval, so #224 is open and unmerged. The five focused source PRs #219–#223 were closed as superseded; their diffs and checks remain available for review.

Material decisions or blockers: review rather than blindly merge major-version Dependabot updates; decide whether the existing scanned-image/SBOM bundle is sufficient for this synthetic Demo or whether registry publication is required; and have a release owner review the artifact identity and scan results. No dependency PRs were merged, no tag or release was created, and no AWS action was taken by this security check.

## Evidence and limits

### Post-merge update, 26 September 2026

PR #224 merged as `df2de03dbc5211c281be5034fde8be04c8718fa7`. Its main Quality and CodeQL workflows passed, and a scan-only release-security run on that exact commit passed all three jobs; see [AWS/hosted attempt](aws-hosted-attempt-2026-09-26.md) for the run, artifacts and bundle digest. The Dependabot alert is resolved. Three of four production CodeQL alerts resolved, but [alert #3](https://github.com/Collaboration95/rewind-app/security/code-scanning/3) is still open on the current main analysis and is being investigated. Thus earlier statements below describing #224 as awaiting review are historical and no longer current.

Sources: main commit and workflow runs linked above; live main files [quality.yml](https://github.com/Collaboration95/rewind-app/blob/main/.github/workflows/quality.yml), [codeql.yml](https://github.com/Collaboration95/rewind-app/blob/main/.github/workflows/codeql.yml), [release-security.yml](https://github.com/Collaboration95/rewind-app/blob/main/.github/workflows/release-security.yml), [dependabot.yml](https://github.com/Collaboration95/rewind-app/blob/main/.github/dependabot.yml); open Dependabot PR search; workflow artifact metadata for run 36232000177.

The checked-out local repository was on `codex/sprint-label-reconciliation` at `8b2da51` with pre-existing modified/untracked files. It was not pulled or altered for this review. GitHub files and workflow data above were read directly from main. The note is the only new local path.
