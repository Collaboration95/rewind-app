# AWS, IaC, and SCP execution plan

**Status:** Proposed for Sprint Planning
**Prepared:** 17 September 2026 (Asia/Singapore)
**Scope:** Sprint 1 hosted Demo and the following production-transition sprint

## Executive decision

Ship Sprint 1 as a deliberately small AWS Demo appliance in `ap-southeast-1`:

```text
GitHub Actions
  tests -> build immutable image -> publish commit-SHA image to private ECR
                         |
                         v
AWS Lightsail 2 GB instance (single host)
  Caddy/Nginx -> Node 22 API + FFmpeg worker (pinned image digest)
  persistent SQLite + temporary/processed synthetic media
                         |
                         v
Lightsail Distribution (generated HTTPS endpoint)
  static Expo web export + uncached /api/*
```

Use Terraform for infrastructure as code, with a small number of explicit
operator scripts for bootstrap, deploy, migrate, reset, and rollback. Keep the
application boundary unchanged: synthetic Demo access is not authentication,
the host is not highly available, and no private/personal media is accepted.

This is the fastest credible route to the Sprint 1 outcome. It avoids spending
the critical path on Cognito, RDS, SQS, Kubernetes, or multi-account account
factory work before the capture-to-reveal journey works.

## Assumptions and defaults

| Decision              | Default for planning                                                                 | Why                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Region                | `ap-southeast-1`                                                                     | Supplied by the team; keep all regional resources here.                                                             |
| Compute               | One Lightsail Linux instance, 2 GB                                                   | Fits Node + FFmpeg and keeps operations understandable.                                                             |
| Public endpoint       | Lightsail Distribution default HTTPS domain                                          | Removes a purchased domain and avoids a separate frontend host.                                                     |
| Frontend              | Expo static export served by the same distribution                                   | Same-origin API calls remove most CORS setup.                                                                       |
| Runtime               | Node 22 LTS, existing `package.json`/CI baseline                                     | Avoids a toolchain upgrade during the demo sprint.                                                                  |
| Image registry        | Private ECR repository with immutable commit-SHA tags and digest pinning             | Gives repeatable deploys and a clean rollback target without making the host a build machine.                       |
| Persistence           | SQLite and media on mounted/persistent instance storage                              | Matches the current local runtime and survives process/container restart.                                           |
| IaC                   | Terraform with pinned AWS provider and committed lock file                           | Familiar declarative workflow and reviewable plans.                                                                 |
| State                 | Versioned, encrypted S3 backend with S3 lock file                                    | Shared state without committing state locally. Terraform documents `use_lockfile` and recommends bucket versioning. |
| CI identity           | GitHub Actions OIDC role, branch/environment constrained                             | Avoids long-lived AWS credentials in GitHub.                                                                        |
| Human access          | IAM Identity Center/role assumption where available; temporary credentials otherwise | Do not use root or share permanent keys.                                                                            |
| SCP meaning           | AWS Organizations Service Control Policy, conditional on an org-managed account      | An SCP is a permission ceiling, not an access grant.                                                                |
| File transfer meaning | Prefer SSM or a controlled deploy command; `scp` is fallback only                    | Do not make laptop media or `.env` files part of deployment.                                                        |

The current repository has no infrastructure directory, container definition, or
AWS workflow. The plan therefore starts with a small new `infra/` boundary and
does not mix infrastructure changes into product PRs.

## The decisions the team must confirm

These are the only decisions that block the first infrastructure PR:

1. Confirm the AWS account ID and that the team may create Lightsail, IAM, S3,
   Budgets, and (if applicable) Organizations resources in it.
2. Confirm `ap-southeast-1` and choose an available Lightsail Availability Zone
   after querying the account; do not hard-code an unavailable zone.
3. Confirm the cost ceiling and alert recipients. Use a monthly budget with
   actual and forecasted alerts; the working defaults are USD 20 warning,
   USD 25 forecast warning, and USD 30 critical. AWS Budgets supports both
   threshold types and up to ten email recipients. [AWS budget guidance](https://docs.aws.amazon.com/cost-management/latest/userguide/create-cost-budget.html)
4. Confirm whether this is a standalone account or an AWS Organization member.
   If standalone, no SCP can be attached; use IAM guardrails instead.
5. Confirm who owns the break-glass account and who reviews `terraform apply`.

Separately, identify one physical device for optional capture evidence. This is
not an infrastructure blocker and does not change the guaranteed synthetic
hosted path.

Credentials can be supplied later. They must be used only for bootstrap, never
committed, and revoked/rotated after the first role-based workflow is working.

## Sprint 1 plan: ship the hosted Demo

### Phase 0 — decision and safety gate (half day)

- Record the choices above in `s2-architecture-001` once the account details
  are confirmed.
- After the account and budget decisions are recorded, add a Sprint 1 milestone
  and create small implementation issues from the slices below; do not create
  one aggregate AWS PR.
- Verify the account identity, region, service quotas, billing access, and
  whether Organizations/SCP is available.
- Create the budget alert before creating compute or distribution resources.

**Exit:** an account/region/owner/cost decision exists and no credential is in
the repository, issue text, logs, or CI configuration.

### Phase 1 — IaC bootstrap and local container (1–2 days)

- Add a pinned Node 22 + FFmpeg production-shaped container/Compose service
  that runs as non-root and exposes `/health`.
- Create a private ECR repository with a short lifecycle policy (retain the
  latest 5–10 release images) and never deploy a mutable `latest` tag.
- Add persistent data/media mount points and an explicit `REWIND_DATA_DIR`.
- Add `terraform fmt`, `validate`, `plan`, and architecture checks to CI.
- Bootstrap an S3 state bucket with public-access block, encryption, versioning,
  and `use_lockfile = true`. The bootstrap is a one-time local operation; later
  changes use the remote state.
- Add local `migrate`, `seed`, `reset`, `readiness`, and safe diagnostics commands.

**Exit:** container preflight and `npm run check` pass locally; state recovery
and lock behavior are demonstrated without storing `terraform.tfstate` in Git.

### Phase 2 — Demo host and HTTPS (1–2 days)

- Provision a tagged Lightsail instance, static IP, least-open public ports,
  seven daily AutoSnapshots, and persistent disk/data directories. Keep one
  release-candidate snapshot before a risky migration.
- Apply `Project=rewind`, `Environment=demo`, `Owner`, `ManagedBy=terraform`,
  and `ExpiresOn` tags to every cost-bearing resource.
- Install the container runtime and reverse proxy through cloud-init or a
  versioned bootstrap script. Pin the image digest used by the host.
- Create/import a Lightsail Distribution and configure the instance as origin.
  Use the **cache nothing** behavior for the API and allow the methods the
  runtime actually handles. Forward query strings and the session inputs.
- Serve the Expo `dist` output and route `/api/*` to the Node service. Set
  `Cache-Control: no-store` on API/session/media authorization responses.

Lightsail distributions can use an instance, bucket, container service, or load
balancer as origin; they support forwarding `POST`, `PUT`, `PATCH`, `DELETE`,
and `OPTIONS`, and allow header/query-string forwarding. API caching must remain
off because authorization and session inputs are request-specific. [Lightsail distribution request behavior](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-distribution-request-and-response.html)

If the Terraform provider cannot express a required distribution setting, create
the distribution once through the console, import it into state, and document
that narrow exception. Do not block the demo on a provider feature gap.

**Exit:** the generated HTTPS endpoint serves the web shell and a real `/health`
response; a clean browser can reach the API without a cross-origin workaround.

### Phase 3 — Deploy and operate (1 day)

- Build and test on every PR; publish an immutable ECR image only from a green
  `main` workflow. The host deploys a commit-SHA/digest, never `latest`.
- First deploy manually from a trusted operator machine. Automate the exact same
  steps after the smoke test is green.
- Keep application deployment separate from Terraform; a release must not
  mutate networking, IAM, SCPs, or state.
- Run migrations before readiness is reported. Seed/reset only the Demo data.
- Use a release manifest containing commit SHA, image digest, migration state,
  and deployment timestamp.
- Roll back by selecting the previous image digest and restoring the previous
  configuration; never roll back by editing files on the host.
- Capture health/version, safe logs, restart persistence, reset, and one denied
  cross-group request as release evidence.
- Configure the monthly budget and a cost-anomaly email alert before media
  testing; alerts are warnings, not a hard spending cap.

**Exit:** the hosted URL passes the Sprint 1 acceptance script once, survives a
process/container restart, and can be reset without a source edit.

### Phase 4 — Product critical path (in parallel)

The AWS work must not wait for the film work, and the film work must not wait
for a polished deployment UI:

1. [#57](https://github.com/Collaboration95/rewind-app/issues/57): compile clips
   chronologically, normalize audio, and publish atomically.
2. [#61](https://github.com/Collaboration95/rewind-app/issues/61): bounded retry
   and truthful delayed/failure state.
3. [#63](https://github.com/Collaboration95/rewind-app/issues/63): authorized
   premiere playback with no pre-release media disclosure.
4. Follow with #65 Archive, #67 local/hosted happy-path proof, #71 resilience,
   #75 runbook, and #73 device/web validation.

**Hosted checkpoint 1:** HTTPS shell + health + Demo session.
**Hosted checkpoint 2:** synthetic clip sealed + owner advance.
**Hosted checkpoint 3:** playable film + authorized playback + reset/repeat.

## IaC repository shape

```text
infra/
  terraform/
    bootstrap/              # state bucket, OIDC provider/roles
    demo/                   # ECR, Lightsail, static IP, ports, distribution, budget
    modules/                # small reusable modules only when repetition exists
  policies/
    iam/                    # deploy, terraform-plan, terraform-apply policies
    scp/                    # staged org guardrails; never auto-attached by CI
  scripts/
    bootstrap-account.sh
    deploy-demo.sh
    migrate-reset.sh
    rollback-demo.sh
  container/
    Dockerfile
    compose.demo.yml
    Caddyfile
  runbook.md
```

Use separate Terraform roots/state keys for `bootstrap` and `demo`; keep any
Organizations/SCP policy JSON and attachments in a separate management-account
root; avoid workspaces for the only environment. Every resource gets tags such as
`Project=rewind`, `Environment=demo`, `ManagedBy=terraform`, and `Owner=team`.

The S3 backend should enable versioning and encryption and use a dedicated
state prefix. Terraform's current S3 backend supports lock files via
`use_lockfile`; versioning is recommended for recovery. [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)

## IAM, credentials, and CI/CD

### Bootstrap

- Use the supplied access keys only in a local AWS profile or environment for
  the one-time bootstrap. Never place them in `.tf`, GitHub variables, issue
  comments, shell history, or artifacts.
- Create a human/operator role and a CI deploy role; immediately test role
  assumption and rotate/revoke the bootstrap keys.
- Enable MFA on the root/break-glass identity and do not use root for normal
  work. AWS recommends temporary role credentials instead of long-lived keys.
  [AWS IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

Use four named boundaries so permissions stay reviewable:

- `RewindBootstrapAdmin`: human-assumed, MFA-protected, one-time bootstrap and
  emergency recovery; never used by CI.
- `RewindTerraformPlan`: GitHub OIDC, read/plan and state-lock access only.
- `RewindTerraformApply`: GitHub OIDC from the protected environment, manually
  approved, and limited to tagged Demo infrastructure.
- `RewindDemoDeploy`: ECR push/read plus the tagged instance's temporary deploy
  access; no Terraform, IAM, Organizations, SCP, or billing permissions.

### GitHub Actions

- Add `id-token: write` only to the deployment job.
- Trust only this repository and the intended branch/environment in the OIDC
  role's `sub` condition; do not trust all repositories or all branches.
- Keep `terraform plan` pull-request-only and require an environment approval
  for `apply`/deploy from `main`.
- Use least privilege: separate plan/read, infrastructure apply, and runtime
  deploy permissions. The deploy role must not administer Organizations, SCPs,
  IAM, billing, or Terraform state.

GitHub's AWS OIDC guidance explicitly recommends constraining the role trust
policy's `sub` claim so unrelated workflows cannot obtain AWS credentials.
[GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)

The release workflow is deliberately separate from infrastructure apply:

1. Pull requests run the existing checks, build the container, run its health
   preflight, and run `terraform fmt`, `validate`, and (when relevant) `plan`.
2. A green merge to `main` builds one `linux/amd64` image and pushes its commit
   SHA to ECR.
3. The deploy job obtains temporary credentials, uses SSM when available (or
   short-lived IP-restricted SSH), backs up SQLite, pulls the exact image
   digest, runs additive migrations, polls readiness, and runs the hosted smoke
   test.
4. A failed readiness/smoke check restores the previous digest/configuration;
   port 22 is closed in an unconditional cleanup step.

Terraform `apply` is a separate manually approved workflow. An application
release must never change networking, IAM, Organizations, SCPs, or Terraform
state.

### Runtime secrets

The current Demo runtime has no need for real user authentication secrets. Keep
it that way in Sprint 1. If a deployment secret becomes necessary, store it in
SSM Parameter Store/Secrets Manager and inject it at deploy time; do not pass it
as a Terraform variable that will be written to state.

## SCP plan (only if the account is Organization-managed)

SCPs are coarse-grained permission ceilings. They do not grant access, do not
affect the management account, and can block even an administrator in a member
account. [AWS SCP behavior](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)

### Sprint 1 posture

Do **not** make an SCP a prerequisite for the hosted Demo. If the supplied
account is standalone, record “not applicable” and enforce the same intent with
IAM policies, budget alerts, and resource configuration.

If it is Organization-managed:

- Put the Demo account in a dedicated sandbox/Demo OU if the team controls the
  organization.
- Start with a tested deny-list policy that blocks only clearly out-of-scope,
  high-cost services; preserve the required regional/global service exceptions.
- Add a region guardrail only after testing global services such as IAM, STS,
  Budgets, CloudFront/Lightsail distribution APIs, and support APIs.
- Never allow the application deploy role to attach/detach SCPs or change the
  organization root.
- Test in a sandbox OU, record the policy version, and keep a break-glass path.

AWS recommends testing SCPs in a separate organization/OU before expanding them
to broader scope. [SCP creation and testing guidance](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps_examples.html)

### Sprint 2 posture

After the hosted path is stable, introduce a versioned baseline SCP with:

- approved-region restriction with documented global-service exceptions;
- denial of disabling central audit/budget controls;
- denial of unapproved expensive or unrelated services;
- protection against public storage/resource sharing where applicable;
- explicit exceptions for the Terraform and break-glass roles.

Apply it through a reviewed management-account change, never from the product
deployment pipeline.

## Secure-copy interpretation

If “SCP” means Secure Copy Protocol rather than Service Control Policy, it is
not the architecture. The preferred path is an immutable ECR image pulled by
the host. For the initial Lightsail appliance, use SSM Session Manager only if
the instance can be registered and audited; otherwise the deploy job may obtain
temporary SSH access details, open port 22 only to the operator/runner `/32`,
pull the image, and close the port in an unconditional cleanup step. Never SCP
private media, AWS keys, or `.env` files.

AWS documents Session Manager as avoiding open inbound ports and SSH key
management where supported. [Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)

## Sprint 2: production-transition plan

Do not start this work until Sprint 1 proves the hosted journey twice from reset.

### Sprint 2 goals

1. Split environments/accounts: Demo/staging and production under AWS
   Organizations, with IAM Identity Center and reviewed SCP guardrails.
2. Move Terraform state and applies to account-specific roles with GitHub OIDC;
   no operator access keys in CI.
3. Replace instance-disk media with private S3 temporary/processed buckets and
   lifecycle expiration; preserve an adapter so Lightsail remains a rollback
   target during migration.
4. Move SQLite to PostgreSQL/RDS only after measuring the actual query and
   concurrency needs; keep a migration/rollback rehearsal.
5. Move compilation to an SQS-backed worker service (ECS/Fargate or equivalent)
   only when the persistent-job contract and failure tests are green.
6. Add managed TLS/custom domain, structured redacted logs, metrics/alarms,
   backup restore tests, and a documented incident/rollback runbook.
7. Replace synthetic Demo sessions with Cognito/OIDC only as a separate product
   decision; do not silently relabel Demo access as authentication.

### Sprint 2 exit criteria

- Separate account/environment plans apply from GitHub OIDC with approval.
- Restore drills recover database and media within the agreed demo RTO/RPO.
- No public bucket/object or unrevealed media path is reachable.
- A failed deploy and failed compilation can be rolled back without data loss.
- SCP, IAM, budget, and logging changes have owners and review evidence.

For velocity, make Sprint 2 a private authenticated staging slice first:

1. Commit account guardrails, authentication, private S3 media, audit events,
   and actionable alarms.
2. Pull PostgreSQL/RDS only after that slice is green and a restore rehearsal
   is scheduled.
3. Pull SQS and an independently deployable worker only after durable job and
   idempotent retry semantics are proven.
4. Defer ECS/Fargate migration until capacity remains; keep the Lightsail Demo
   appliance as a rollback target throughout.

## Proposed issue slicing (not created yet)

The existing Sprint 1 plan already owns the `s2-cloud-*` keys below. Use this
table to sequence and tighten those outcomes; do not create duplicate GitHub
issues. Create only the explicitly marked decision/security slices after the
team confirms the account and budget:

| Key                       | Outcome                                                                            | Sprint | Estimate |
| ------------------------- | ---------------------------------------------------------------------------------- | ------ | -------: |
| `s2-architecture-001`     | Record account, region, hosting, storage, media, backup, rollback, and SCP posture | 2      |      2 h |
| `s2-cloud-001`            | Build the Node 22 + FFmpeg image and publish immutable ECR releases                | 2      |      4 h |
| `s2-cloud-002`            | Persist SQLite and processed Demo media                                            | 2      |      3 h |
| `s2-cloud-003`            | Terraform the Lightsail instance, static IP, firewall, snapshots, and ECR          | 2      |      5 h |
| `s2-cloud-004`            | Provision/import the HTTPS distribution and same-origin routing                    | 2      |      4 h |
| `s2-cloud-005`            | Deploy the Expo web export behind the distribution                                 | 2      |      3 h |
| `s2-cloud-006`            | Deploy by digest, migrate/readiness, and rollback without Terraform                | 2      |      6 h |
| `s2-cloud-007`            | Add hosted migrate, seed, reset, and readiness commands                            | 2      |      3 h |
| `s2-cloud-008`            | Add budget, health/version, safe logs, snapshots, and restart evidence             | 2      |      4 h |
| `s2-security-001` _(new)_ | Bootstrap IAM roles, OIDC trust, and credential rotation                           | 2      |      4 h |
| `s2-scp-001` _(new)_      | Determine SCP applicability; stage/test guardrails or record N/A                   | 2      |      2 h |
| `s3-org-001`              | Split accounts/OUs and apply reviewed SCP baseline                                 | 3      |      8 h |
| `s3-iac-001`              | Multi-account Terraform roles/state and OIDC apply approvals                       | 3      |      6 h |
| `s3-media-001`            | S3 media adapter and lifecycle policy                                              | 3      |      8 h |
| `s3-data-001`             | PostgreSQL/RDS migration and restore rehearsal                                     | 3      |     10 h |
| `s3-worker-001`           | SQS + independently deployable compilation worker                                  | 3      |     10 h |

These are planning slices, not authorization to create remote issues yet.

## Sprint 1 sequence and shipping-velocity guardrails

The AWS/IaC portion is about 40 team-hours in total: roughly 32 hours of cloud
delivery, 6 hours of IAM/SCP controls, and 2 hours for the architecture
decision. It should run in parallel with the film work, not as a gate in front
of it.

Recommended order:

1. Record the account, region, budget, owners, and SCP applicability.
2. Bootstrap the state bucket and OIDC roles.
3. Build the container, persistent paths, readiness, and local smoke harness.
4. Provision ECR, Lightsail, static IP, firewall, tags, and snapshots.
5. Provision/import the HTTPS distribution and verify same-origin routing.
6. Perform one manual digest deploy, then automate that exact workflow.
7. Add backup/reset/rollback evidence, budget and anomaly alerts, and the
   operator runbook.
8. Run the hosted smoke test after the film path reaches #57 → #61 → #63.

Parallel lanes:

- Cloud lane: steps 1–5.
- Runtime lane: container, persistence, health, and synthetic ingestion.
- Film lane: #57 compilation followed by #61 retry/delayed state.
- Archive lane: #63 authorized premiere against a deterministic fixture.
- Quality lane: local/hosted smoke harness from Day 1.

Do not wait for credentials to implement the container, Terraform module shape,
deploy scripts, or local checks. If access is delayed, run `fmt`/`validate` and
reviewed plans locally, but do not claim a hosted checkpoint until the real
account endpoint is exercised.

## Risk controls and stop conditions

- **Account access delayed:** implement and test container, Terraform modules,
  and local deploy scripts against LocalStack or a mocked plan; do not fake a
  hosted checkpoint.
- **Distribution/API incompatibility:** fall back to a Lightsail container
  service/default HTTPS endpoint or a documented temporary reverse proxy; keep
  API traffic off plain HTTP.
- **SCP threatens access:** detach/revert the staged policy from the sandbox
  OU; never experiment on the organization root.
- **Budget exceeds alert:** stop media testing, preserve a snapshot, and remove
  unused instances/IPs/distributions before continuing.
- **Film path slips:** keep P0 on one or two deterministic clips; cut chat,
  filler, physical capture, and nonessential retry polish before cutting
  compile/publish/playback.
- **Credentials exposed:** revoke immediately, inspect CloudTrail, replace the
  credential path with OIDC/role assumption, and record the incident without
  including the secret.

## Definition of Done for infrastructure work

An infrastructure issue is Done only when its Terraform plan/apply or operator
procedure is reviewable, state is recoverable, credentials are not long-lived in
CI, the hosted health/smoke check passes, rollback is demonstrated, and the
corresponding Project status and issue evidence are updated.
