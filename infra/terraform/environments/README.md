# Dev and prod Terraform roots

`dev/` and `prod/` are independent S3-backed Terraform roots. They call the
shared `modules/runtime/` module with fixed environment identifiers; the module
derives unique Lightsail instance, static-IP, backup-bucket, backup-prefix, and
optional HTTPS distribution names from that identifier. The existing `demo/`
root and all its resource addresses remain separate and unchanged.

Each root declares an S3 backend and its reserved key is recorded in
`backend/dev.hcl.example` or `backend/prod.hcl.example`. Do not initialize a
remote backend until the state/OIDC work from #174 is coordinated. A
read-only `ListObjectsV2` inventory of the state bucket under `rewind/` found
only `rewind/bootstrap/terraform.tfstate` and `rewind/demo/terraform.tfstate`;
the reserved dev and prod keys were unused at that inspection. Recheck before
remote initialization. Then provide the matching backend configuration during
`terraform init`; do not copy state from Demo or migrate a Demo address into
these roots.

The app host and bucket names/prefixes are environment-specific. HTTPS uses
the Lightsail distribution's provider-managed domain, enabled separately with
`https_distribution_enabled = true`; this configuration does not create custom
DNS records or certificates. SSH defaults to loopback-only and needs an
approved operator CIDR before any reviewed plan intended for deployment.

These roots are infrastructure scaffolding, not an accepted environment. The
host does not yet receive the application bootstrap/deployment configuration.
Runtime backup clients are still Demo-specific, and the roots do not yet grant
environment-scoped backup IAM, create a separate media service, or implement
the #174 OIDC identities. Do not apply until the live Demo/state inventory,
deployment integration, IAM/OIDC, cost review, and human-reviewed plan gates in
issue #230 are complete. `terraform validate` with `-backend=false` checks the
configuration only; it does not prove account isolation, state-key availability,
resource availability, cost, or live health.
