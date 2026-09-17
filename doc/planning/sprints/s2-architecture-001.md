# s2-architecture-001 — AWS demo foundation

**Status:** Accepted on 17 September 2026

## Decision

Sprint 2 uses the existing standalone AWS account `330599756236` through the
non-root IAM profile `macos-m1`. The default and only deployment region is
`ap-southeast-1`; the existing demo host is in `ap-southeast-1a`.

The demo budget is USD 15 per calendar month with actual-cost notifications at
USD 10 (warning) and USD 15 (critical). These notifications are alarms, not a
hard cap. Spend protection is layered: only one `micro_3_0` Lightsail instance,
explicit Terraform resource allowlist, private/versioned S3 buckets with short
lifecycle retention, and human-reviewed Terraform applies.

The account is not part of AWS Organizations, so SCPs do not apply. IAM roles
and permissions boundaries are the applicable guardrails.

## Ownership

- Break-glass owner: the account owner using MFA-protected root access only for
  recovery; root is never used for daily work or configured locally.
- Terraform-apply owner: a named human operator, initially the `macos-m1` IAM
  operator while dedicated role assumption is being bootstrapped.
- Coding agents: read/validate only by default; they may not administer IAM,
  billing, CloudTrail, Organizations, or apply infrastructure.

## Consequences

AWS infrastructure is represented in Terraform and state lives in the private,
encrypted, versioned S3 backend. Docker deployment, migrations, and backups are
versioned operator scripts rather than Terraform resources. Existing AWS
resources are imported rather than destroyed and recreated.
