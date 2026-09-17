# Rewind Multi-Account Plan

## Current approach: Terraform first

The Rewind AWS account is currently standalone, without AWS Organizations or service control policies (SCPs). Provision infrastructure from version-controlled Terraform roots, with separate state keys for bootstrap and demo infrastructure. The power controller remains in the demo root while it controls one demo instance; split it into a dedicated automation state root only when it serves multiple environments or service groups. Review `terraform plan` before every apply and keep applies human-approved.

Terraform is the best fit now because it already describes the existing Lightsail, S3, CloudTrail, budget, IAM, and automation resources. It also gives us a repeatable recovery path for another standalone account. Keep application data and secrets outside Git: Terraform recreates infrastructure; migrations recreate SQLite schema; S3 backups restore data.

## Why StackSets are not applicable yet

CloudFormation StackSets are designed to distribute stacks across accounts and/or Regions under a managing account. This account has no Organization, delegated administrator, or OU structure for centralized StackSet deployment. A single-account StackSet would add a second provisioning system without providing multi-account value, while Terraform is already the source of truth.

StackSets may become appropriate when accounts are governed centrally and foundational resources must be deployed uniformly. They should not be introduced now merely to replace the existing Terraform workflow.

## Future Organizations transition

When the product needs isolation, create an AWS Organization with separate accounts such as:

- Management/security: billing, organization administration, and break-glass controls.
- Shared services: centralized audit and carefully selected shared tooling.
- Development/demo: low-cost Rewind environments.
- Production: isolated production workloads and data.

Before moving workloads, define account ownership, billing contacts, region policy, logging ownership, backup ownership, and the break-glass process. Enable SCPs only after testing them against every required provisioning and recovery action.

There are two supported provisioning models:

1. **Terraform modules and state per account (recommended initially).** Reuse modules for logging, budgets, IAM boundaries, networking, and application infrastructure. Use one state root per account and environment, with account-specific provider aliases and variables. A central pipeline assumes a tightly scoped role in each target account.
2. **CloudFormation StackSets.** Use service-managed StackSets with Organizations/OUs for uniform account baselines, such as CloudTrail, Config, IAM guardrails, and budget notifications. Keep application-specific resources in Terraform unless there is a clear operational reason to standardize them through CloudFormation.

Do not manage the same resource with both Terraform and CloudFormation. If a resource changes ownership, import it into the receiving system and remove it from the original state/template in a reviewed migration.

## Phased migration

### Phase 0 — Standalone foundation

- Keep the current account Terraform-first.
- Keep separate state for bootstrap and demo; split automation state only when
  the controller serves multiple environments.
- Use least-privilege plan, apply, deploy/backup, and coding-agent roles.
- Restrict resources to `ap-southeast-1`, approved names, and required Rewind tags.
- Keep schedules disabled until explicitly enabled and retain the `$10` warning / `$15` critical budget alerts.
- Test backup, restore, and emergency shutdown procedures.

### Phase 1 — Organization readiness

- Establish the management account and security/audit ownership.
- Create OUs and account vending procedures.
- Define SCPs in a test account; begin with region, service, and protection guardrails.
- Centralize CloudTrail delivery without removing local recovery access.
- Create per-account Terraform roles and remote state locations.

### Phase 2 — Baseline rollout

- Apply a versioned baseline module to each account, or deploy an equivalent StackSet to selected OUs.
- Verify logging, encryption, budgets, tags, IAM boundaries, and recovery access account by account.
- Record imports and drift checks before moving any application workload.

### Phase 3 — Workload migration

- Provision the target account from Terraform modules and a new state key.
- Back up SQLite/media to S3 and verify checksums and a manifest.
- Deploy and restore into the target environment.
- Validate health, permissions, cost alerts, and rollback before changing traffic.
- Retire the old resources only after the recovery window expires.

## Guardrails

- No root access keys; require MFA for human break-glass access.
- The coding agent is read-only by default and cannot manage IAM, billing, Organizations, or destructive resources.
- Terraform plan is readable by automation; apply requires an approved human identity.
- Apply roles use permissions boundaries, explicit resource ARNs, approved Regions, and required tags.
- Protect CloudTrail, state, and backup buckets from agent and deployment roles.
- Use S3 encryption, versioning, public-access blocking, lifecycle retention, and periodic restore tests.
- Do not add NAT gateways, RDS, load balancers, distributions, or other recurring-cost services without a cost review.
- Treat budget alerts as warnings, not a hard AWS spending cap; retain a documented emergency shutdown procedure.

## Recovery

Keep Terraform code, provider lock files, policy documents, and runbooks in Git. Keep state in private, versioned S3 with a documented bootstrap path. If an account is lost or unusable:

1. Obtain a replacement account and MFA-protected bootstrap access.
2. Recreate the state bucket and baseline logging/budget controls.
3. Configure the account-specific Terraform backend and provider role.
4. Apply the reviewed Terraform roots to recreate infrastructure.
5. Restore SQLite/media from the verified S3 backup and run application migrations.
6. Validate health, access logs, budgets, and cost inventory before reopening traffic.

For an Organizations model, preserve the management/security account separately from workload accounts, retain an independent break-glass path, and keep an export of StackSet operations and Terraform state versions. Recovery must be possible even if the normal CI/CD role or one workload account is unavailable.
