# Rewind Terraform

Terraform is the source of truth for AWS infrastructure. Application deployment,
migrations, backup and restore scripts stay in [`deploy/`](../../deploy/README.md)
because they run inside the already-provisioned host.

The `demo` root and every `rewind-demo*` resource are the hosted dev host for
the real-account app. "Demo" in their names and in this README is historical;
the synthetic Demo product was removed on 6 October 2026. Do not rename these
resources or the state key: that would replace the live host.

## Roots

| Root                                    | Creates                                                                                                                                                                     | State key                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `bootstrap/`                            | Terraform state bucket, GitHub OIDC provider, `rewind-coding-agent` role, optional environment identities                                                                   | `rewind/bootstrap/terraform.tfstate` |
| `demo/`                                 | Dev host: Lightsail instance `rewind-demo` and static IP, CloudFront distribution, backup and audit buckets, CloudTrail, budget, deploy role, legacy power controller       | `rewind/demo/terraform.tfstate`      |
| `media/`                                | Per-environment media bucket and runtime IAM user, Cognito pool and client, PostgreSQL database, hosted settings object; used by dev directly and by `release/` as a module | `rewind/media/terraform.tfstate`     |
| `release/`                              | Release host `rewind-release`, its CloudFront URL, deploy role, backup bucket, release media/database/Cognito via `media/`                                                  | `rewind/release/terraform.tfstate`   |
| `environments/dev`, `environments/prod` | Prepared media-only roots, see [their README](environments/README.md). Not the live roots.                                                                                  | `rewind/{dev,prod}/media.tfstate`    |

Shared modules: `modules/private-media` and `modules/environment-identity`.

## Safety rules

- This Mac stores the bootstrap credential as AWS's `default` profile
  (`macos-m1` is the IAM username). Normal reviewed changes use
  `AWS_PROFILE=rewind-terraform-apply`; use `default` only to assume roles. Agents
  use `rewind-coding-agent` (read-only). Never use an AWS root user or commit
  credentials.
- Start with `plan`; only the named Terraform-apply owner runs `apply`, after the
  second reviewer has seen the exact plan. Budgets alert but do not cap spend.
- Compute is explicit: `demo_instance_enabled=true` creates the dev host and
  `false` removes it. The host runs continuously; backup-gated hibernation
  (`destroy-demo.sh`) was retired in #512.
- Instance `user_data` drift is ignored so editing `cloud-init.sh` does not
  replace a running host. A rebuilt host gets the current script; an existing
  host is updated by application deployment, or rebuilt with `wake-demo.sh`.
- State is private, encrypted, versioned and ignored by Git. `.tf` files and
  provider lock files belong in Git.

## Sprint 2 dev/prod transition boundary (#230)

This section keeps the original #230 gates. Dev and release now exist as the
`demo`, `media` and `release` roots above; the gates still describe what must be
evidenced before a new environment is treated as complete.

The current `demo` root and its remote state are preserved until a read-only
inventory reconciles the live Demo resources, S3 buckets, Terraform addresses,
state keys, and resource ownership. Do not parameterize, move, import, or retire
the Demo resources based only on this checkout: the coding profile cannot read
the remote state or enumerate the S3 buckets. In particular, a proposed
dev/prod backend key must first be checked against the remote state bucket for
an existing object.

The inert backend examples under `environments/backend/` reserve distinct state
keys for dev and prod roots. The offline `infra/scripts/check-environment-backends.sh`
guard checks them against each other and the preserved Demo key; it cannot
inspect the remote state bucket. #167 Organizations/SCP work and #261
database migration are outside this slice.

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

The offline preservation test pins only the Demo Lightsail instance name and
resource address, static-IP name and resource address, static-IP attachment
address, public-ports address, and example backend key. It does not pin or
verify CloudTrail, S3, budgets, IAM, Lambda, scheduler, or any other Demo
resources. Static checks cannot prove remote-state separation, bucket isolation,
HTTPS behavior, or cost acceptance; those remain live/human verification
requirements.

## Deployment identity

There is one hosted dev host and no separate integration host. `Deploy dev`
(`.github/workflows/deploy-dev.yml`) deploys to it from CI and never runs
Terraform. Two reviewed pieces make that possible:

- The bootstrap root creates the account-level GitHub OIDC provider
  (`github_oidc_provider_arn` output; set the variable instead if the account
  already has one).
- The `demo` root creates `rewind-demo-deploy`, trusted only for the repository's
  `dev` environment on `refs/heads/dev` (the immutable `sub` and the classic
  form, no wildcard). It may read the instance address and open or close ports on
  that one host. It cannot start, stop, delete, resize or reach media buckets. It
  is declared beside the instance so its policy tracks a rebuilt host's ARN. The
  release root creates the equivalent role for the `release` environment on `main`.

Apply bootstrap first, then `demo`; the `demo` plan should add only the role and
its policy:

```sh
export AWS_PROFILE=rewind-terraform-apply
cd infra/terraform/bootstrap && terraform init -backend-config=backend.hcl && terraform plan -var-file=terraform.tfvars
cd ../demo && terraform init -backend-config=backend.hcl && terraform plan -var-file=terraform.tfvars
```

Copy each `*.tfvars.example` and `backend.hcl.example` to the ignored real file
first. The `demo` tfvars need the real budget recipients and your current SSH CIDR.

## Operating model

- Guruprasath is the apply and break-glass owner; Andrew reviews plans. Guruprasath
  owns the $10 warning and $15 critical cost alerts. Subscriber addresses stay in
  private Terraform inputs.
- Region `ap-southeast-1`, zone `ap-southeast-1a`. Recovery uses CIDR-restricted
  SSH from the trusted operator machine.
- A failed restore preserves every recovery artifact.
- The dev host's single public entry point is
  `https://d2m6kz76y4kuvm.cloudfront.net`. Do not create another public hostname;
  the retired optional Lightsail distribution stays retired.

## Cost safeguards

- Dev runs one `micro_3_0` Lightsail instance continuously, plus managed
  PostgreSQL (`media/database.tf`, about US$15/month). Release adds its own host
  (about US$7/month), database and CloudFront usage. No NAT gateway, load
  balancer, ECR or extra compute is declared.
- $10 actual-cost warning and $15 actual-cost critical budget alerts are code.
- Backups expire after 30 days (superseded versions 7 days, the temporary release
  archive prefix 3 days). CloudTrail logs have matching 30-day/7-day retention.
  Superseded state versions expire after 90 days.
- Terraform apply is limited to a small service allowlist (no EC2, RDS, VPC/NAT,
  ECR, ECS or Organizations); extending it needs a reviewed Terraform change.

## Coding-agent profile

Bootstrap creates `rewind-coding-agent`, a read-only role for inspecting the
Lightsail host, cost and budget status, CloudTrail status and bucket safety
settings. It cannot read backup or state contents, deploy, change IAM or billing,
start or stop compute, or change logging. After the bootstrap root is applied, add
this to the local AWS config (never to the repository) and run agents with
`AWS_PROFILE=rewind-coding-agent`:

```ini
[profile rewind-coding-agent]
role_arn = <output coding_agent_role_arn>
source_profile = default
region = ap-southeast-1
```

## Host rebuild and the legacy power controller

Rebuild the dev host with the reviewed Terraform profile:

```sh
./infra/scripts/wake-demo.sh --latest
./infra/scripts/wake-demo.sh --latest --apply --confirm
```

Wake is read-only by default and checks the caller account, Terraform identity
tags and the expected or absent Lightsail resources before a plan is eligible.
`--latest` and `--manifest` restore SQLite-era recovery points, so they apply
only to a host that keeps its database on disk; `--seed` is the first-install
exception. See [deploy/README.md](../../deploy/README.md#restore-and-host-rebuild).

`demo/automation.tf` still declares a small Lambda, `rewind-demo-power-controller`,
and a role the operator can assume to invoke it. It has no public endpoint and
is described in its IAM description as legacy. It accepts `start`, or `stop` with
a recent backup manifest key, and can only start or stop the one tagged instance.
No schedule exists unless `automatic_start_schedule_expression` is set (default
`null`), and nothing in the deploy workflows uses it.

## Recovery model

Terraform recreates cloud infrastructure. Cloud-init installs host prerequisites.
Database and media data come from PostgreSQL recovery and S3. Keep these layers
separate when recovering into a replacement account.

## Media root (`media/`)

A private, versioned, SSE-S3 (`AES256`) media bucket plus a runtime IAM user
limited to it (Lightsail cannot use instance roles). Browsers upload with signed
PUT URLs. CORS allows only the hosted app and `make run`.

```sh
cd infra/terraform/media && cp backend.hcl.example backend.hcl
AWS_PROFILE=rewind-terraform-apply terraform init -backend-config=backend.hcl
AWS_PROFILE=rewind-terraform-apply terraform plan
```

Terraform also writes the hosted settings (bucket, runtime credentials, database
URLs, Cognito, web push subject) to a private object under `_config/` in that
bucket. Only the environment's deploy role may read it, and each deploy streams
it to `deploy/release-host.sh configure`. The server generates its web push keys
once and keeps them. Nobody copies credentials by hand.

### Database (`media/database.tf`)

Managed PostgreSQL 17 per environment, controlled by `local.database_settings`
(`enabled`, `cutover`, `bundle`, `public`). Dev is enabled and cut over, public
with TLS required. Release is enabled and private with `cutover = false` until its
import is reconciled; configuration is not proof of a live apply. Operate it with
the [PostgreSQL runbook](../../docs/architecture/postgresql-operations.md) and
[release cutover](../../docs/architecture/release-cutover.md).

### Cognito sign-in (`media/cognito.tf`)

Each environment gets one user pool (`rewind-<environment>`), a public app client
(authorization code + PKCE, no secret), a prefix domain and Managed Login v2
branding. Sign-in is by email and password; self sign-up is on; MFA, social login
and custom domains are off. Callback URLs derive from `web_origins` as
`<origin>/api/auth/callback`, logout URLs as `<origin>/`. The settings object
carries `REWIND_COGNITO_*` to the server. The runtime user may only call
`cognito-idp:AdminDeleteUser` on that pool. `auth_password` (default true, dev)
sets `REWIND_AUTH_PASSWORD`; the release module call sets it false.

## Release environment (`release/`)

An independent environment next to dev: host `rewind-release`, its own CloudFront
URL, deploy role (GitHub `release` environment on `main` only), backup bucket
`rewind-release-backups-*`, and release media, database and Cognito through
`media/` with `environment=release`. `deploy-release.yml` deploys qualified `main`
commits; the human gate is `main`'s required review. The release host never gets
dev backup settings. Cutover state is in
[release cutover](../../docs/architecture/release-cutover.md).

## Host alarms

Terraform's AWS provider has no Lightsail alarm resources, so
`infra/scripts/lightsail-alarms.sh` is the idempotent source of truth: failed
status checks, CPU above 90% and burst capacity below 10%, emailed to
`REWIND_ALERT_EMAIL`. Budget alerts stay in `demo/observability.tf`. With
`REWIND_REQUEST_TIMING=true` the runtime logs one `api.request` JSON line per
request.

## Environment identity and reviewed media plans (#174)

`bootstrap/environment-identity.tf` is disabled by default (`{}`). When enabled
it prepares `rewind-{dev,prod}-terraform-{plan,apply}` roles and permissions
boundaries for the private-media roots in `environments/` only (account
330599756236, region ap-southeast-1). This is preparation, not evidence of
provisioned environments.

- Trust requires the exact audience, immutable subject, repository and owner IDs,
  ref (`dev` or `main`) and a distinct environment.
- The manual `Reviewed media Terraform` workflow (`terraform-environments.yml`)
  has no `pull_request` trigger. A `plan` run stores the binary plan and a
  metadata file in the private state bucket under
  `rewind/{env}/reviewed-plans/{runId}/{attempt}/`; nothing goes to GitHub
  artifacts, logs or comments. The plan role can write only those two names. The
  apply role reads only version-pinned objects, applies the saved binary with a
  lock and never replans.
- A human retrieves and renders the plan locally (private directory, `umask 077`),
  checks its SHA-256, metadata version ID and checksums, and supplies those five
  values to the separate `apply` dispatch. Never print or upload the plan.
- Prerequisites before use: human IAM review and a repeat state/artifact key
  inventory; four protected GitHub environments (`terraform-{dev,prod}-{plan,apply}`)
  with required reviewers and no self-review; `MEDIA_KMS_KEY_ARN` and
  `MEDIA_CORS_ORIGIN` per pair; a read-only `TERRAFORM_GH_READ_TOKEN`; and stopped
  external writers (the workflow serializes per environment but cannot stop a
  local writer). There is no automatic artifact cleanup.

Offline check: `node --test tests/terraform/environment-identity.test.mjs`. It
proves no provisioned trust, bucket privacy, real conditional writes or approval.
