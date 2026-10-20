# Private media environment roots

`dev/` and `prod/` are prepared, media-only Terraform roots built on
`modules/private-media`. They are **not** the live hosted infrastructure: hosted
dev and release use `infra/terraform/media` and `infra/terraform/release`, whose
buckets use SSE-S3. These roots add a stricter variant (SSE-KMS with a reviewed
customer-managed key) and are used by the reviewed-plan workflow described in the
[Terraform README](../README.md#environment-identity-and-reviewed-media-plans-174).

No resource or state key is assumed to exist. Inventory names and keys before
initialising or importing. The reserved state keys are `rewind/dev/media.tfstate`
and `rewind/prod/media.tfstate`; `backend/*.hcl.example` hold the whole-environment
reservations and `infra/scripts/check-environment-backends.sh` checks them offline.

What the module creates:

- A private, versioned bucket: public access and ACLs blocked, non-TLS and
  cross-account access rejected, explicit SSE-KMS uploads with one reviewed key
  ARN. The root checks that the key is enabled, symmetric and customer-managed in
  this account and Region. It creates no key.
- Lifecycle rules by the signed `rewind-media-class` tag matched to the key
  segment: incoming objects expire after one day (current and noncurrent);
  processed clips and films do not expire. Upload capabilities bind the tag, so a
  client cannot reclassify an original to escape expiry. Worker cleanup still
  deletes accepted originals promptly; lifecycle is the fallback.
- An unattached runtime policy: scoped listing, tagged writes, version-pinned
  reads and version deletion for that environment's bucket and prefix, and
  `GenerateDataKey`/`Decrypt` for the reviewed key only, through S3 in the declared
  Region. Bucket Keys are off so object-level encryption context matches the
  prefix restriction. Attach the policy to a reviewed runtime identity yourself;
  Lightsail gets no role from the policy existing.

Web clients receive short-lived signed upload capabilities, never runtime
credentials. Set the exact public HTTPS CORS origin; the example `.invalid`
origins and key ARN are placeholders.

Before a live plan or apply, still required:

- A remote state and resource inventory with an ownership map.
- Distinct plan, apply and runtime identities (#174) and explicit human review.
- A dated cost estimate, including per-object KMS requests, and approved alert
  owners.
- Real S3 CORS, encryption, versioning and lifecycle tests. Offline fixtures are
  preparation, not evidence.

Local checks: `terraform fmt -check -recursive infra/terraform` and
`node --test tests/terraform/private-media-policy.test.mjs`. Do not initialise a
real backend or assume an apply role to run them.
