# AWS and hosted Demo attempt — 26 September 2026

Checked at approximately 11:08 UTC against `origin/main` commit `df2de03dbc5211c281be5034fde8be04c8718fa7` (merged PR #224). **No AWS resource was created, changed, started, or deleted. There is no deployed HTTPS endpoint yet.**

## Release and security evidence

- Main [Quality checks](https://github.com/Collaboration95/rewind-app/actions/runs/36237307651) and [CodeQL](https://github.com/Collaboration95/rewind-app/actions/runs/36237307652) succeeded on that exact commit.
- Built a release bundle from a clean, detached checkout of that commit using `python3 deploy/release.py build --green-sha df2de03dbc5211c281be5034fde8be04c8718fa7 --config-version demo-v1`. `deploy/release.py verify` confirmed the same commit. Local bundle: `/private/tmp/rewind-df2de03dbc5211c281be5034fde8be04c8718fa7.tar` (324 MB); SHA-256 `1ce1aecef6cab8e040c9c0ec48fdc827dedf03edba5196f40b70fd39d5fed452`. This `/private/tmp` file is local and ephemeral, not a published release artifact.
- Manually dispatched [scan-only release-security run](https://github.com/Collaboration95/rewind-app/actions/runs/36237806296) on the same main commit. Runtime image, web image, and IaC scans all succeeded. Retained artifact digests: runtime `sha256:e4178448a93968d041fe2ce5059f0a0b077479c4076d38e97e840a18cedc25b8`, web `sha256:168229b46657467109c53a5d443ef1d2cf0d0c3deea7d3398cc3cb254fa55c6e`, IaC `sha256:608460be90ae79aa4976e0463b8c75db107ad5128520fa133bfb3c344048b6c2`.
- `terraform fmt -check -recursive infra/terraform` and `terraform -chdir=infra/terraform/demo validate` succeeded on the locally prepared configuration. The local ignored `terraform.tfvars` proposes `public_https_distribution_enabled=true`, an allowlist entry for `rewind-demo-web -> rewind-demo`, and expected instance state `running`. It has **not** been applied or committed. The merged-main HTTPS origin/policy tests passed, 15/15.
- Main currently has zero open Dependabot alerts. CodeQL alert [#3](https://github.com/Collaboration95/rewind-app/security/code-scanning/3), `js/xss-through-dom` in `src/capture/platform.ts`, remains open on the exact merged-main analysis despite #224; it is under separate investigation. The other three former production alerts are resolved.

## Live read-only checks and blocker

- `AWS_PROFILE=rewind-coding-agent` identified the expected account. Lightsail inventory showed no Demo instance or static IP in `ap-southeast-1`, and no distribution through the required `us-east-1` distribution API. Therefore there is no hostname to probe for #200 or run hosted journeys against for #145.
- AWS's bundle APIs report `micro_3_0` at **US$7/month** and `small_1_0` distribution at **US$2.50/month**: approximately **US$9.50/month** together if retained for a whole month, before S3/logging/transfer overages. Actual-cost alerts at US$10 and US$15 are notifications, not a spending cap. Transfer overage has no fixed maximum here.
- S3 `ListObjectsV2` showed a candidate `rewind-20260921T060633Z` manifest (345 bytes), database archive (7,874 bytes), and media archive (110 bytes). `s3:GetObject` of the manifest returned `AccessDenied` for `rewind-coding-agent`. This proves **neither backup validity nor invalidity**; bytes, checksums, and restorability cannot be verified with this role.
- A fresh `terraform init -reconfigure -backend-config=backend.hcl` using only `rewind-coding-agent` received S3 state `HeadObject` HTTP 403. No current plan was produced. The direct resource deletion recorded in issue #190 may have left Terraform state stale, so the older plan counts must not be reused.
- The real `wake-demo.sh --latest --dry-run` was run on the verified release bundle with `TF_AWS_PROFILE=rewind-coding-agent` and `BACKUP_AWS_PROFILE=rewind-coding-agent`. It stopped at `no complete valid recovery point exists` because this profile cannot download candidates. It performed **no apply, SSH, SCP, or rsync**. `--seed` was not used because historical recovery candidates exist.

## Exact remaining sequence

1. A designated recovery operator with scoped backup read access downloads the selected manifest and both archives and runs the repository's manifest/schema, size, and checksum checks. Do not treat the S3 listing as verification; investigate whether the newest candidate is a suitable recovery point. Preserve the original data.
2. Andrew reviews a **fresh plan generated against the remote state** and the proposed HTTPS/audit variables, including any state reconciliation required after the earlier direct deletions. Reject unexpected changes. The `rewind-terraform-apply` profile is reserved for human-reviewed Terraform work by the [AWS operations skill](/Users/speedpowermac/.codex/skills/rewind-aws-operations/SKILL.md).
3. Guruprasath runs the guarded `wake-demo.sh --latest --apply --confirm` only after backup verification and plan review, with the exact bundle digest above and approved credentials/configuration. Record the actual applied plan, restored release ID, AWS inventory and distribution hostname.
4. Verify `https://<hostname>/` and `/api/health`, then perform two clean hosted journeys, restart/persistence and rollback/fallback checks, and a non-author hosted acceptance run. Do not close #190, #200, #145, or tracker #203 without those respective results.

The dirty original checkout and its private configuration were not modified. The proposed Terraform variables exist only in an ignored file in the isolated `/private/tmp/rewind-main-verify` worktree.
