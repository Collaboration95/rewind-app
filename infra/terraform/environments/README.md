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
requires explicit SSE-KMS uploads with one reviewed customer-managed key ARN, and checks the signed `rewind-media-class` tag
against the incoming/processed/films key segment. Upload capabilities bind this
header; the client cannot reclassify an original to escape incoming expiration.
Incoming current/noncurrent versions expire after one day; processed clips and
films have no expiration rule. Worker cleanup remains responsible for deleting
accepted originals promptly; asynchronous S3 lifecycle is a fallback. Immutable
version/checksum reads remain the application's ownership/integrity boundary.

Direct transfer is negotiated with `GET /real/media/config?uploadProtocol=2`.
Older/unversioned clients receive `directTransfer: false` and keep the existing
server-owned staging path, whose S3 writes add the class tag internally. The
new tag-aware client also accepts earlier untagged capabilities. Before hosted
storage activation, verify the old-client staged path and new-client direct path
against the configured store and drain any pre-existing direct capture/upload
sessions; a stale client holding a tagged capability fails closed and retains its
source for retry. No hosted S3 mode is activated by this PR.

See [S3 object tagging and lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-tagging.html).

The runtime policy permits scoped listing, tagged writes, pinned reads and
version deletion for only the declared environment bucket/prefix. It permits
GenerateDataKey/Decrypt for only the reviewed key, through S3 in the declared
Region, for the account and object environment prefix. Bucket Keys are disabled
to retain object-level encryption context; their bucket-level context would not
match the prefix restriction ([AWS encryption-context guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html)).
The root checks that the supplied key is enabled, symmetric and customer-managed
in this account/Region. It creates no key, key policy or AWS credentials. The
example key ARN is nonexistent placeholder data; approved key inventory,
key-policy/runtime permissions and KMS request cost remain rollout gates.
Attach the runtime policy only to the reviewed environment runtime identity
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
  approved KMS key allocation and per-object KMS requests,
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
