# Release cutover and deployment

This procedure covers #504, #515 and #230. Configuration preparation is not a
completed release. At source baseline `40ebeb5673d103b4b6950d095192aae744980769`,
release PostgreSQL is disabled, release Cognito is declared but not verified live,
and the release application has not completed its first deployment.

## Prepare the isolated environment

Use `infra/terraform/release` and its existing state key
`rewind/release/terraform.tfstate`. Inspect with `rewind-coding-agent`; plan and
apply with `rewind-terraform-apply`. Review the saved plan and disclose its
cost before applying. No resource replacement or dev changes are expected.
Keep release `cutover = false` until retained SQLite data has been reconciled.
A declaration of `enabled = true` does not mean an apply or cutover occurred.

The release module provides its own private `rewind-release-postgres`, generated
logins, Cognito pool/client with the release callback/logout origins, and a
versioned encrypted `rewind-release-backups-330599756236` bucket. Logical backups
use only `rewind-release/`. The host settings carry the explicit bucket/prefix;
release operations reject missing settings and dev defaults.

Set `REWIND_DATABASE_BOOTSTRAP_URI` in each GitHub **environment** from that
root's `database_bootstrap_uri` output. Release's value is
`s3://rewind-release-media-330599756236/_config/release-database-bootstrap.env`.
Dev retains its own value. Do not put credentials in GitHub variables or logs.

## Incremental cost (15 October 2026)

The saved preparation plan adds one `micro_2_0` database (US$15/month), a backup
bucket and Cognito Essentials; no new host or standby. Singapore S3 Standard is
US$0.025/GB-month for the first 50 TB. Thirty retained 1 GB daily backups are
about US$0.75/month; thirty 40 GB backups are about US$30/month. Noncurrent
versions, request/transfer charges and media growth add to these examples.
A rehearsal database accidentally retained for a full month adds US$15.
Thus the 1 GB/day example adds about US$15.75/month; the 40 GB/day example with
one retained rehearsal adds about US$60/month, before usage charges. There is
no finite worst-case bill without a workload bound or spending cap. Existing
US$10/US$15 alerts notify rather than cap spending.

Cognito Essentials direct/social login has a shared account allowance of
10,000 monthly active users, then US$0.015 per MAU. Do not assume the allowance
is entirely available to this pool. Manual database snapshots cost
US$0.05/GB-month. Existing hosts, distributions and dev resources are excluded
from these incremental estimates.

Sources: [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/) (Singapore rate checked against
AWS's regional public price list), [Cognito pricing](https://aws.amazon.com/cognito/pricing/).

## Respect the protected promotion

Promotion PR #531 targets `main`. Its exact head must pass aggregate Quality,
including slow web checks, coverage and accessibility, and receive the required
collaborator review. A review-agent pass does not satisfy a GitHub approval.
The protected `release` environment requires AndrewNguyenLKN and prevents
self-review (observed 15 October 2026). Preserve both gates. Do not approve the
old `bac471c` deployment just to clear a waiting run.

The normal release workflow builds only the exact main revision whose main
push Quality succeeded. Apply isolated Cognito settings before allowing the
application deploy: release disables developer password sign-in.

## Move retained data without a second writer

The **Database operations** workflow requires an explicit target: dev on `dev`,
release on `main`. Role, host, region, bootstrap object and host environment must
match. Its concurrency is shared with that environment's deployment workflow.
It cannot run from `main` until the workflow itself has been promoted there.

1. After protected main promotion, dispatch **Deploy release** with `operation=prepare`
   before the first application startup. It preserves retained SQLite/WAL and disk
   media in `backups/first-start-retained.tar`, with a private inventory. It refuses
   symlinks, open writers, more than 100,000 files/10 GiB or insufficient disk.
   Verify the inventory, including an explicit empty result. Preparation installs
   verified tools without starting the application; operations use its pending SHA.
   Keep SQLite authoritative. Keep merges/deployments for that environment on hold during
   the cutover; the other environment may continue serving.
2. Run `bootstrap` for the selected target. It creates/rotates only its generated
   app and read-only roles. Verify the selected database's environment binding.
3. Run `import` without a manifest for the final snapshot. It stops the backup
   timer/service, web proxy and runtime. The runtime contains the HTTP server,
   scheduler, reminders and media workers. Also stop any manually launched
   worker before proceeding. One-shot Node/tar containers take the SQLite/media
   backup without starting runtime writers; import reconciles every table's
   count and content hash in one transaction. The workflow passes the exact manifest
   returned by that snapshot; it never selects remote latest. A successful receipt
   binds environment, manifest digest and table reconciliation. Writers remain stopped
   on failure.
   A selected older manifest is recovery to that point, not a lossless cutover.
4. Inspect the reconciliation report. Set release `cutover = true`, review/apply
   the release-only plan, then deploy the qualified main revision normally.
   A maintenance marker prevents restarting SQLite writers. PostgreSQL activation
   requires a final-snapshot receipt for the matching environment and a fresh hash
   comparison before any writer starts. Successful health validation restores the
   backup timer.
5. Run `status`, verify PostgreSQL engine, current migration/environment, restart
   persistence, and run `backup`. Logical dumps must restore successfully into
   the local verifier before upload. Rehearse managed restore with the explicit
   release target and record measured recovery-point age and usable-restore
   time; no dev measurement establishes release recovery. Managed rehearsal stops all
   writers, captures a hash baseline, waits for the provider recovery window to reach
   it and restores that exact timestamp. Both restored and still-stopped source must
   match. It leaves maintenance active on success or failure: inspect, then explicitly
   run `resume`. Stop manually launched workers before dispatch. Restore creation is
   restricted to source snapshots tagged with the selected environment; tagging
   and deletion require an already-labelled rehearsal. If Lightsail's create-time
   tag authorization has no existing resource tags, this deliberately fails closed.
   Record that limitation and obtain a separately reviewed provisioning plan;
   never widen tagging to all resources to make a rehearsal pass.

If import fails, preserve source SQLite, backups and the stopped state. Retry
only after resolving the cause; `resume` abandons the window and starts the
still-selected authoritative database after readiness. After PostgreSQL has
accepted writes, use the reconciled reverse export in
[PostgreSQL operations](postgresql-operations.md#reverse-export-and-database-only-switch)
for a lossless SQLite rollback. Flipping to the old SQLite file loses new writes.

## Verify the deployed product

Check dev and release HTTPS health, deployed SHA, database engine/schema and
isolation. Using owned data, exercise release provider login, onboarding,
invitation return, cold session restore, cancellation/retry, sign-out and media.
Reject expired/replayed callbacks, developer password login and cross-environment
sessions. Check the installed PWA where available. Email/OTP or physical-device
checks unavailable to automation remain explicitly unverified.

Verify cross-environment IAM denial using policy checks/owned fixtures; never
read another environment's private objects merely to demonstrate a denial.
Release PostgreSQL is private to Lightsail in-region, not a separate VPC boundary:
logins and the application's environment binding remain required.
