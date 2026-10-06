# Rewind Terraform foundation

Terraform is the source of truth for AWS infrastructure. Application deployment,
database migrations, and backup/restore scripts remain in `deploy/` because they
operate inside the already-provisioned host rather than create cloud resources.

The `demo` root and every `rewind-demo*` resource are the hosted dev host for
the real-account app. "Demo" in their names and in this README is historical;
the synthetic Demo product was removed on 6 October 2026. Do not rename these
resources or the state key: that would replace the live host.

## Safety rules

- This Mac stores the bootstrap credential as AWS's `default` profile;
  `macos-m1` is the IAM username, not a saved profile name. Normal reviewed
  infrastructure changes use `AWS_PROFILE=rewind-terraform-apply`; reserve
  `default` for assuming roles only. Never use an AWS root user or commit
  credentials.
- Start with `plan`; only a named human Terraform-apply owner runs `apply`.
- The disposable compute lifecycle is explicit: `demo_instance_enabled=true`
  creates the host and `false` hibernates it after a verified backup. The
  reviewed `infra/scripts/destroy-demo.sh` workflow is the only documented
  teardown path; the backup bucket and recovery IAM remain managed.
- Instance `user_data` is creation-time bootstrap: its drift alone is ignored
  so edits to `cloud-init.sh` do not replace a running host. Newly created or
  intentionally recreated hosts still receive the current script. Updating
  the script does not update an existing host; use application deployment or
  the backup-gated hibernation/wake workflow as appropriate. No other instance
  fields are ignored, and this rule does not prevent intentional teardown.
- The S3 backend's contents are state, not source code. State is private,
  encrypted, versioned, and ignored by Git; the `.tf` files and provider lock
  file belong in Git.

## Sprint 2 dev/prod transition boundary (#230)

The current `demo` root and its remote state are preserved until a read-only
inventory reconciles the live Demo resources, S3 buckets, Terraform addresses,
state keys, and resource ownership. Do not parameterize, move, import, or retire
the Demo resources based only on this checkout: the coding profile cannot read
the remote state or enumerate the S3 buckets. In particular, a proposed
dev/prod backend key must first be checked against the remote state bucket for
an existing object.

The approved end state is one AWS account with separate `rewind-dev` and
`rewind-prod` Lightsail hosts, SQLite disks, private media buckets, Terraform
states, and operations identities. The existing Demo stays intact through
that transition. The accepted lifecycle has no routine auto-shutdown and no
application database backups; OFF means stopped, while Demo retirement is a
separate reviewed destroy operation. #167 Organizations/SCP work and #261
database migration are outside this slice. OIDC environment claims must be
coordinated with #174 without introducing multi-account assumptions.

The inert backend examples under `environments/backend/` reserve distinct
state keys for future dev and prod roots. They are not environment roots and
must not be used to initialize Terraform until a read-only inventory confirms
the keys are unused and the corresponding configurations exist. The offline
`infra/scripts/check-environment-backends.sh` guard checks the examples against
each other and the preserved Demo key; it cannot inspect the remote state
bucket.

The remaining Demo-specific procedures in this README describe the existing
implementation only. They do not override the dev/prod decisions above or
authorize applying that legacy lifecycle to either new environment.

The `Deploy dev` workflow now deploys the integration branch from GitHub
Actions, but it is not live until a human has reviewed the Terraform change
that grants it an identity, and no environment is complete until all of these
gates have evidence:

1. Reconcile the live Demo resources, S3 buckets, Terraform state addresses,
   ownership, and existing state keys with read-only access.
2. Verify Lightsail's supported runtime identity path; do not guess at static
   credentials or commit credentials to deliver them.
3. Coordinate exact GitHub OIDC repository/branch/environment claims and
   environment-scoped roles with #174.
4. Verify a supported distribution-to-origin trust control and test direct
   forged-forwarded-protocol requests against the origin.
5. Record a dated, complete estimate including Demo overlap, then review the
   $100/month planning ceiling, proposed $80/$100 alerts, recipients, and
   escalation owners. Budgets are alerts, not spend caps.
6. Review the exact Terraform plan before any human-run apply. No automated
   apply is permitted.

## Online deployment identity (#230)

There is no separate integration host. The integration branch deploys to the
existing hosted Demo instance, replacing the operator-machine flow of building
a bundle and running `release-host.sh install` over SSH. Two reviewed changes
make that possible, and neither creates compute:

- The bootstrap root creates the account-level GitHub Actions OIDC provider
  (`output github_oidc_provider_arn`). Set `github_oidc_provider_arn` instead
  when the account already has a provider for the same URL.
- The Demo root creates `rewind-demo-deploy`, which trusts only the OIDC
  `sub` claim for this repository's dev environment together with
  `ref refs/heads/dev`. GitHub issues an immutable subject
  (`repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:dev`), so the policy pins
  that exact subject and the classic `repo:OWNER/REPO:environment:dev` form,
  with no wildcard. It is declared next to the instance so its policy
  always carries the current `aws_lightsail_instance.rewind[0].arn`; a
  hard-coded ARN would silently stop matching after the documented
  hibernation/wake cycle replaces the host. It may read the instance address
  and open or close ports on that one host, and nothing else: no start, stop,
  delete, resize, or media/bucket access.

Apply the bootstrap root first (the Demo root looks the provider up by URL),
then the Demo root. The Demo plan should show only the role, its policy, and
the new variable, with no change to the running host:

```sh
export AWS_PROFILE=rewind-terraform-apply
cd infra/terraform/bootstrap && terraform init -backend-config=backend.hcl && terraform plan -var-file=terraform.tfvars
cd ../demo && terraform init -backend-config=backend.hcl && terraform plan -var-file=terraform.tfvars
```

Deployment itself stays application-only: `.github/workflows/deploy-dev.yml`
never runs Terraform.

The offline preservation test pins only the Demo Lightsail instance name and
resource address, static-IP name and resource address, static-IP attachment
address, public-ports address, and example backend key. It does not pin or
verify CloudTrail, S3, budgets, IAM, Lambda, scheduler, or any other Demo
resources. The inventory gate above covers the broader resource/state safety
boundary. Static checks cannot prove remote-state separation, bucket isolation,
HTTPS behavior, or cost acceptance; those remain live/human verification
requirements.

## Accepted live-Demo ownership and operating model

The live-Demo owners accepted the following operating model on 23 September
2026:

- Guruprasath is the Terraform apply owner and break-glass owner. Andrew is the
  required plan/apply reviewer.
- Guruprasath owns both the `$10` actual-cost warning and `$15` actual-cost
  critical response. Subscriber addresses remain in private Terraform inputs
  and AWS, not in this repository.
- The approved location is `ap-southeast-1`, availability zone
  `ap-southeast-1a`.
- Recovery uses CIDR-restricted SSH from the trusted operator machine.
- Pausing is manual backup-gated hibernation through
  `infra/scripts/destroy-demo.sh`; scheduled starts and direct stop/delete
  operations remain disabled.
- A failed backup or manifest verification leaves the instance running. No
  disposable compute is deleted without a fresh verified recovery point. A
  failed restore preserves every recovery artifact and does not replace
  known-good data.
- Public acceptance uses the single HTTPS entry point documented below. The
  retired optional Lightsail distribution is not part of current deployment or
  hibernation guidance.
- Andrew owns the non-author acceptance run for the hosted journey.

An apply still requires Andrew to review the exact Terraform plan. These
ownership decisions do not replace the plan, backup, identity, inventory, or
rollback gates below.

## One-time adoption of existing AWS resources

The AWS account already contains the state bucket and demo resources. Importing
records those objects in Terraform state; it does **not** recreate them.

1. Install the pinned Terraform version and select the local profile:

   ```sh
   export AWS_PROFILE=rewind-terraform-apply
   cp bootstrap/terraform.tfvars.example bootstrap/terraform.tfvars
   cp demo/terraform.tfvars.example demo/terraform.tfvars
   # Fill real budget recipients and the current SSH CIDR in demo/terraform.tfvars.
   ```

2. Bootstrap root: initialise without a backend, import the existing state
   bucket resources, review its plan, then copy `bootstrap/backend.hcl.example`
   to ignored `bootstrap/backend.hcl` and migrate the local state:

   ```sh
   cd bootstrap
   terraform init -backend=false
   terraform import -var-file=terraform.tfvars aws_s3_bucket.terraform_state rewind-terraform-state-330599756236
   terraform import -var-file=terraform.tfvars aws_s3_bucket_public_access_block.terraform_state rewind-terraform-state-330599756236
   terraform import -var-file=terraform.tfvars aws_s3_bucket_server_side_encryption_configuration.terraform_state rewind-terraform-state-330599756236
   terraform import -var-file=terraform.tfvars aws_s3_bucket_versioning.terraform_state rewind-terraform-state-330599756236
   terraform plan -var-file=terraform.tfvars
   terraform init -migrate-state -backend-config=backend.hcl
   ```

3. Demo root: initialise its remote backend, import resources one at a time,
   and inspect the plan before making any AWS change. Keep the exact import
   transcript in the infrastructure pull request rather than treating an
   unreviewed shell script as authority.

## Intentional cost safeguards

- The active Demo uses one `micro_3_0` Lightsail instance. Hibernated state has
  no instance or static IP; static-IP retention is intentionally out of scope
  for the current sprint and may be revisited later.
- No RDS, NAT gateway, load balancer, ECR, or extra compute is declared here.
- The hosted Demo is accessed at
  `https://d2m6kz76y4kuvm.cloudfront.net`; local Terraform defaults do not
  create a second public HTTPS endpoint.
- The $10 actual-cost warning and $15 actual-cost critical alert are code.
- Backup data expires after 30 days, superseded versions after 7 days, and the
  temporary release archive prefix after 3 days. CloudTrail has matching
  30-day/7-day retention. Superseded Terraform state versions expire after
  90 days; the current state is retained.

The read-only cost-safety audit evaluates one of three explicit expected states:

- `demo_off`: no disposable instance and no static IP unless retention was
  explicitly enabled; configured snapshots and distributions are still the
  complete allowlist.
- `expected_stopped`: one stopped, `Environment=demo` instance with its static
  IP attached; this is the default idle state.
- `approved_active_demo`: one running, `Environment=demo` instance with its
  static IP attached; this is allowed only when
  `cost_safety_expected_instance_state = "running"` is explicitly configured.

`demo_instance_enabled` controls whether Terraform creates the instance; it
does not describe its power state. When the instance exists, the audit's
expected power state is configured independently with
`cost_safety_expected_instance_state`.

Unexpected compute, orphaned or unattached networking, unapproved snapshots or
distributions, and missing backup retention produce redacted findings with a
severity, resource identifier class, expected state, and safe remediation
reference. The audit only observes and reports; it never stops, deletes, or
reconfigures resources. Inventory read errors fail closed without logging AWS
names, object keys, credentials, or exception text.

Audit failure delivery is disabled by default. To use the managed publisher,
set `cost_safety_audit_notification_mode = "sns"` and provide the ARN of a
separately managed SNS topic in
`cost_safety_audit_notification_topic_arn`. The publisher sends one stable,
redacted failure event and records delivery failures without replacing the
audit result. It does not choose recipients or store an email address,
webhook, or credential in this repository.

The audit IAM contract is deliberately narrower than the deployment roles:

- The Lambda role can read the required Lightsail inventory, read backup-bucket
  lifecycle configuration, write only to its own CloudWatch log streams, and
  optionally publish to the configured SNS topic ARN. Lightsail inventory APIs
  require `Resource = "*"`; the bucket, log group, and notification resources
  remain explicit Terraform references.
- The Scheduler role can invoke only the cost-safety Lambda. Its trust policy
  requires both `var.account_id` and the exact `rewind-demo-cost-safety-audit`
  schedule ARN in the managed `rewind-demo` schedule group.
- Neither audit role has permission to stop, start, delete, terminate, or
  otherwise mutate Lightsail/compute resources, bucket objects, IAM, or account
  state. The audit observes and alerts; it never remediates findings.

The policy contract is covered by static assertions in
`tests/terraform/cost-safety-policy.test.mjs`. Run it together with
`terraform fmt -check` and `terraform validate`; no AWS apply or credentials
are required.

Budgets notify after AWS has observed cost; they cannot impose a guaranteed
hard spending ceiling. The practical cap is the small resource allowlist and
manual apply review.

The hosted Demo's single public entry point is
`https://d2m6kz76y4kuvm.cloudfront.net`. Do not enable or recreate the retired
optional Lightsail distribution to publish another hostname. Local development
may use HTTP loopback addresses; those are internal development endpoints and
are not hosted URLs.

## Coding-agent profile

Bootstrap creates `rewind-coding-agent`, a read-only role that can inspect the
Rewind Lightsail host, cost/budget status, CloudTrail status, and bucket safety
settings. It cannot read backup or state object contents, deploy, change IAM,
change billing, stop/start/delete compute, or modify logging.

After a human has applied the bootstrap root, add the following **configuration
only** to the operator's local AWS config (never to this repository), then run
coding agents with `AWS_PROFILE=rewind-coding-agent`:

```ini
[profile rewind-coding-agent]
role_arn = <output coding_agent_role_arn>
source_profile = default
region = ap-southeast-1
```

Keep the `default` human/bootstrap profile out of agent shells. Terraform
apply is human-owned through the `rewind-terraform-apply` profile. Its service
allowlist excludes EC2, RDS, VPC/NAT, ECR, ECS, and Organizations; extending it
requires a reviewed Terraform change.

## Cloud power controller and hibernation

The demo root defines a small Lambda control plane, not a public endpoint. An
operator role can invoke only `rewind-demo-power-controller` with either:

```json
{ "action": "start" }
```

or, after the host backup script uploaded a manifest:

```json
{ "action": "stop", "backup_manifest_key": "rewind-demo/rewind-<timestamp>.manifest.json" }
```

The Lambda can start or stop only the tagged Rewind Lightsail instance; it can
only read backup manifest objects, not database/media backups. A future
automatic start schedule is opt-in through
`automatic_start_schedule_expression`. No automatic stop schedule exists,
because cloud automation must not bypass the host's backup-and-verify step.

The legacy `rewind-demo-operator` Lambda remains only for an already-existing
instance and is disabled while `demo_instance_enabled=false`. The normal
operator flow uses the human-reviewed Terraform profile:

```sh
./infra/scripts/destroy-demo.sh --dry-run
./infra/scripts/destroy-demo.sh --apply --confirm
./infra/scripts/wake-demo.sh --latest
./infra/scripts/wake-demo.sh --latest --apply --confirm
```

The scripts default to read-only guard and plan mode. They verify the caller
account, Terraform identity tags, expected/absent Lightsail resources, and the
absence of unexpected Rewind resources before a plan is eligible. `--apply`
requires the separate `--confirm` flag. `wake-demo.sh` downloads and verifies
the selected manifest and matching archives before it creates compute, then
restores the files on the new host before starting the runtime. It never treats
a newly-created empty database as a successful recovery. The explicit
`wake-demo.sh --seed` mode is only the first-install exception when no
historical recovery point exists; it must be run with `--apply --confirm` to
execute and must be followed by a complete backup before hibernation.
Hibernation uploads the host-created snapshot from the trusted operator
machine, so recreated hosts do not need to inherit AWS CLI credentials.

## Recovery model

Terraform recreates cloud infrastructure. Cloud-init installs host
prerequisites. S3 backups restore database/media data. Keep these three layers
separate when recovering into a replacement account.

## Bounded environment identity preparation (#174)

`bootstrap/environment-identity.tf` is disabled by default (`{}`). Its optional
module prepares distinct `rewind-{dev,prod}-terraform-{plan,apply}` roles and
permissions boundaries for the accepted **private-media roots only**. Account
330599756236 and region ap-southeast-1 are fixed. Existing media KMS key ARNs
must be supplied; these roles only describe those keys. Bucket metadata includes
`ListBucket`, needed for the provider's `HeadBucket`, and may reveal object names;
private-media object contents remain inaccessible. State grants use
`rewind/{dev,prod}/media.tfstate`, with apply-only `.tflock` writes and exact
resource-account conditions. Only the default Terraform workspace is supported;
the pinned S3 backend tolerates denied non-default workspace discovery without
granting access to other environment states. Future hosting `terraform.tfstate`
keys from #298 are excluded. Hosting permissions, KMS creation, IAM roles/pass/
attachments and Organizations/billing grants require separate review. Runtime
policy version writes are limited to the exact `rewind-{dev,prod}-private-media`
policy ARN. Review its content and all attachments before provisioning the apply
identity. Runtime media permissions grant no state or reviewed-plan access.

Trust requires exact audience, immutable subject, repository/owner IDs,
repository name, ref (`dev` for dev, `main` for prod), and distinct environment.
AWS documents the supported GitHub `ref`, `environment` and ID condition keys in
[the IAM condition-key reference](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).
The recorded immutable subject prefix is
`repo:Collaboration95@68595032/rewind-app@1354608509`; operations recheck it with
`gh api` and fail closed if GitHub's subject configuration changes.

The manual `Reviewed media Terraform` workflow is preparatory, **not enabled or
provisioned evidence**. No PR checkout receives AWS credentials. The repository
is public, so plans never enter GitHub artifacts, logs, PR comments or summaries.
Only run/attempt/environment/head coordinates, SHA-256 digests and the metadata
version ID appear in the summary. Private saved-plan exchange uses the existing
private bucket `rewind-terraform-state-330599756236` and exactly two object names:

- `rewind/{env}/reviewed-plans/{runId}/{attempt}/plan.tfplan`
- `rewind/{env}/reviewed-plans/{runId}/{attempt}/metadata.json`

The helper derives these keys from dev/prod and positive numeric GitHub run and
attempt IDs; it accepts no arbitrary bucket, prefix or object key. These prefixes
are separate from every backend key: `rewind/bootstrap/terraform.tfstate`, Demo's
`rewind/demo/terraform.tfstate`, current dev/prod `media.tfstate`, and #298's
reserved dev/prod `terraform.tfstate`. Plan identity may write only these two
artifact leaf names in its environment, in addition to its read-only state and
resource metadata access. Apply identity may read only version-pinned artifact
objects; it cannot publish, overwrite or delete artifacts. Neither role lists
artifact prefixes, deletes artifact versions, creates the shared state bucket,
or changes its policy/lifecycle. Existing runtime identity grants none of these
artifact or state operations. Plan output writes are separate from infrastructure
mutation; Terraform planning still uses `-lock=false` and cannot write state.

Uploads use fixed regional HTTPS, expected owner 330599756236, explicit AES256,
SHA-256 and `If-None-Match: *`. The role policy also requires TLS, the resource
account, AES256 and the conditional header. Metadata is published last and binds
source run/attempt, head, environment, exact state key, variables hash, provider
lock hash, Terraform version and the binary plan's S3 version/ETag/checksum.
A collision fails; an interrupted metadata upload leaves an orphaned plan.
Do not overwrite/delete it or reuse that run+attempt. A new reviewed plan must
use a new attempt. Both objects must return non-null version IDs and checksums.
[Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)
provide the write precondition; this patch does not introduce a bucket policy,
Object Lock or lifecycle rule.

Before use:

1. Obtain human IAM/private-plan review and repeat the 3 October inventory of
   state and artifact keys. Verify bucket ownership, all public-access blocks,
   bucket policy/ACLs, SSE-AES256 and enabled versioning, existing media keys,
   OIDC provider and all IAM attachments. No inventory or cloud configuration
   was performed by this coding slice. Review shared bucket retention/policy
   separately: there is **no automatic artifact cleanup or expiration** here.
   The existing shared lifecycle affects historical versions, not live artifact
   keys. Confirm cost, retention and any future authorized cleanup before use.
2. Configure all four `terraform-{dev,prod}-{plan,apply}` GitHub environments with
   required human reviewers, prevent self review, disable administrator bypass,
   and permit protected branches only. Existing `dev` and `release` environments
   do not satisfy these distinct gates. Exact branch head must have green
   aggregate Quality. Set matching `MEDIA_KMS_KEY_ARN` and `MEDIA_CORS_ORIGIN`
   for each plan/apply pair; missing configuration fails closed.
3. Supply `TERRAFORM_GH_READ_TOKEN`, a fine-grained **read-only** GitHub credential
   for repository/branch metadata, environment protection, OIDC customization,
   checks and Actions run metadata. No AWS static credentials. API denial or
   absent protections refuses the operation before AWS assumption.
4. Stop external writers and affirm quiescence on each dispatch. Both modes
   share one workflow concurrency group per environment with cancellation off.
   Actions serialization cannot stop a local or different-workflow writer;
   quiescence is an operator prerequisite, and apply also acquires the state lock.
5. Dispatch `plan` from the exact reviewed protected branch. An authorized human
   AWS identity must retrieve and review the private metadata and binary plan;
   the read-only coding-agent profile has no artifact data access. An explicitly
   authorized `rewind-terraform-apply` human profile is one existing option, subject
   to the Rewind AWS workflow and its review requirement. Confirm caller account
   before retrieving. Use the published metadata version ID, expected bucket
   owner, fixed HTTPS endpoint and checksum-enabled `s3api get-object`. Verify
   its SHA-256 against the summary, AES256 and version receipt, then retrieve
   `plan.tfplan` using the version ID and `If-Match` ETag inside that verified
   metadata. Check both the returned checksum and binary SHA-256. Do not retrieve
   state objects or request a public/presigned URL. Keep files in a private local
   directory (`umask 077`); redirect AWS receipts to private files. Use the pinned
   Terraform version to render `terraform show -no-color plan.tfplan > plan.txt`
   and `terraform show -json plan.tfplan > plan.json` locally. Review the complete
   resource/policy diff and metadata. Never print/upload the plan or JSON to GitHub.
6. For the separate human-approved `apply` dispatch, supply plan run ID, attempt,
   binary SHA-256, metadata SHA-256 and exact metadata version ID from that review.
   Approvers must compare all five inputs with the reviewed private files before
   granting environment approval. The helper verifies the successful manual source
   run at the unchanged exact head through `gh`, fetches that exact metadata S3
   version, checks the approved hash and configuration, then fetches the binary
   with its pinned version and ETag. All downloads check AES256 and SHA-256.
   It applies only the saved binary with a lock, never replans. Terraform rejects
   stale state; destructive or out-of-scope resources fail the operation guard.
   All subprocess output and CLI errors are withheld from GitHub logs.

Offline verification: `node --test tests/terraform/environment-identity.test.mjs`
is included by existing root/Quality Terraform test globs. Backend-disabled
Terraform validation and mocked module tests require no AWS credentials or cloud
calls. Transport tests use an offline S3 fixture; they do not prove provisioned
trust, bucket privacy/versioning, actual AWS conditional writes, remote-state
separation, provider permission coverage or real environment approval. Human
review, provisioning, private-plan operational acceptance and safe read-only
PR-plan acceptance remain open under #174; this preparation does not close it.

## Media root (`media/`)

Private, versioned, SSE-S3 encrypted media bucket for the hosted server, plus a
runtime IAM user limited to that bucket (Lightsail cannot use instance roles).
Browsers upload with signed PUT URLs; CORS allows only the hosted app and
`make run-real`. State lives at `rewind/media/terraform.tfstate`, separate from
the live demo root.

```sh
cd infra/terraform/media && cp backend.hcl.example backend.hcl
AWS_PROFILE=rewind-terraform-apply terraform init -backend-config=backend.hcl
AWS_PROFILE=rewind-terraform-apply terraform plan
```

Terraform also writes the hosted settings (bucket, runtime credentials, web push
subject) to the private object `s3://<bucket>/_config/dev.env`, which only the
dev deploy role may read. Each dev deploy streams it to
`deploy/release-host.sh configure`; the server generates its own web push keys
once and keeps them. No one copies credentials by hand.

## Host alarms (`infra/scripts/lightsail-alarms.sh`)

Terraform's AWS provider has no Lightsail contact-method or alarm resources, so
this idempotent script is the source of truth for the dev host's alarms:
failed status checks, sustained CPU above 90% and burst capacity below 10%,
emailed to `REWIND_ALERT_EMAIL` (AWS sends a one-time verification link).
Budget alerts stay in `demo/observability.tf`. With `REWIND_REQUEST_TIMING=true`
the runtime logs one `api.request` JSON line per request (method, route
template, status, duration) next to the existing `api.failure` lines.

## Release environment (`release/`)

A second, independent environment (#230) next to dev: Lightsail host
`rewind-release`, its own CloudFront HTTPS URL, its own media bucket and
runtime user (the `media/` root reused as a module with `environment=release`),
and a deploy role trusted only for the GitHub `release` environment on `main`.
`.github/workflows/deploy-release.yml` deploys qualified `main` commits; the
human gate is `main`'s required review. The release host never receives dev
backup settings, so it cannot read or restore dev backups. State lives at
`rewind/release/terraform.tfstate`. Extra cost is about US$7 per month (micro
instance and static IP) plus CloudFront usage.
