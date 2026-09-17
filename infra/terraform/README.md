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
- `prevent_destroy` protects the current Lightsail instance and static IP. A
  deliberate teardown needs a reviewed code change to remove that protection.
- The S3 backend's contents are state, not source code. State is private,
  encrypted, versioned, and ignored by Git; the `.tf` files and provider lock
  file belong in Git.

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

- The only compute is one `micro_3_0` Lightsail instance, protected against
  accidental Terraform deletion.
- No RDS, NAT gateway, load balancer, ECR, distribution, or extra compute is
  declared here.
- The $10 actual-cost warning and $15 actual-cost critical alert are code.
- Backup data expires after 30 days, superseded versions after 7 days, and the
  temporary release archive prefix after 3 days. CloudTrail has matching
  30-day/7-day retention. Superseded Terraform state versions expire after
  90 days; the current state is retained.

Budgets notify after AWS has observed cost; they cannot impose a guaranteed
hard spending ceiling. The practical cap is the small resource allowlist and
manual apply review.

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

## Cloud power controller

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

The local `rewind-demo-operator` profile assumes the invoke-only operator role.
Use `infra/scripts/wake-demo.sh` to start and
`infra/scripts/stop-demo.sh <manifest-key>` to request a verified stop.

## Recovery model

Terraform recreates cloud infrastructure. Database migrations recreate the
SQLite schema. S3 backups restore database/media data. Keep these three layers
separate when recovering into a replacement account.
