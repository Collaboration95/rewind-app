# Rewind Terraform foundation

Terraform is the source of truth for AWS infrastructure. Application deployment,
database migrations, and backup/restore scripts remain in `deploy/` because they
operate inside the already-provisioned host rather than create cloud resources.

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

The remaining Demo-specific procedures in this README describe the existing
implementation only. They do not override the dev/prod decisions above or
authorize applying that legacy lifecycle to either new environment.

No environment resources, state migration, IAM grants, or deployment workflows
are ready for live use until all of these gates have evidence:

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
