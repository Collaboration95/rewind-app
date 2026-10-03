# Private media environment roots

`dev/` and `prod/` prepare separate media-only state roots. They create a new
private, versioned S3 bucket and an unattached runtime policy. They do not move
any Demo/shared state address, provision hosts, attach a runtime identity, deliver
credentials or configure the hosted app. No resource or state key is assumed to
exist: inventory the names and keys before initialization or import.

The reserved keys are `rewind/dev/media.tfstate` and `rewind/prod/media.tfstate`.
PR #298's whole-environment backend reservation and #174's plan/apply identities
remain separate work. Existing Demo/backend ownership stays unchanged.

The module blocks public access and ACLs, rejects non-TLS/cross-account access,
requires explicit AES256 uploads, and checks the signed `rewind-media-class` tag
against the incoming/processed/films key segment. Upload capabilities bind this
header; the client cannot reclassify an original to escape incoming expiration.
Incoming current/noncurrent versions expire after one day; processed clips and
films have no expiration rule. Worker cleanup remains responsible for deleting
accepted originals promptly; asynchronous S3 lifecycle is a fallback. Immutable
version/checksum reads remain the application's ownership/integrity boundary.

See [S3 object tagging and lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-tagging.html).

The runtime policy permits scoped listing, tagged writes, pinned reads and
version deletion for only the declared environment bucket/prefix. It creates no
AWS credentials. Attach it only to the reviewed environment runtime identity
through the #174/#230 credential-delivery design. Lightsail does not receive a
role merely because an IAM policy exists. Web clients receive short-lived signed
capabilities, never runtime credentials. Set the exact public HTTPS CORS origin;
the example `.invalid` origins are placeholders. Preserve the reviewed HTTPS
proxy/cookie/origin-authentication boundary; these roots do not change it.

Before live planning/apply, #349/#230 still require:

- Exact remote state/resource inventory, imports and ownership map, including
  any overlapping Demo/shared resources and retained disk media (#170).
- Distinct reviewed plan/apply/runtime identities and account assertions (#174),
  with serialized environment operations and explicit human plan/apply review.
- Dated total cost for both hosts, HTTPS/distributions, DNS, transfer, S3 versions,
  shared account services and alerts; the $100 planning ceiling is not a cap.
- Approved alert owners/recipients and escalation thresholds; preserve current
  $10/$15 alerts until a reviewed change is accepted.
- Exact plans, provider validation and real S3 CORS/encryption/version/lifecycle,
  origin-authentication and cross-environment access tests. Offline fixtures and
  configuration are preparation, not evidence of live resources or acceptance.

For local formatting and policy fixtures, use `terraform fmt -check -recursive infra/terraform` and
`node --test tests/terraform/private-media-policy.test.mjs`. Provider validation
requires the pinned provider schema. Do not initialize a real backend, assume an
apply role or run cloud operations to make these local checks pass.
