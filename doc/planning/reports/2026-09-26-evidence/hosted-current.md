# Hosted Demo check — 2026-09-26

Scope: read-only assessment of Sprint 2 hosted gates #200 and #145 against merged main (`6708066`). No AWS mutations, AWS CLI calls, Terraform plan/apply, or GitHub issue edits were performed.

## Findings

- Main does not contain a concrete HTTPS hostname. `infra/terraform/demo/web-distribution.tf` exports `public_https_distribution_domain` as an apply-time output. `infra/terraform/demo/terraform.tfvars.example` sets `public_https_distribution_enabled = false`, and `infra/terraform/README.md` confirms that the distribution is opt-in and the hostname is available only after provisioning.
- The runbook (`deploy/README.md`) requires checking `/` and `/api/health` through the public HTTPS distribution; loopback health is explicitly insufficient. With no configured hostname or known live distribution, there is no safe, attributable public origin to probe. Accordingly, no endpoint request or hosted journey was attempted. This leaves #200's deployed-origin proof and #145's hosted acceptance unverified.
- This session's shell could not resolve `api.github.com` (`curl: (6) Could not resolve host`), so it could not fetch live issue comments or deployment metadata to discover a newer endpoint.
- Cloud-free targeted tests: `node --test tests/web-deployment.test.mjs tests/terraform/web-distribution-policy.test.mjs` first produced 12 pass and one localhost-bind `EPERM` in the sandbox. The coordinating run repeated it with localhost permission on merged main: **13 pass, 0 fail**. This verifies the cloud-free origin/routing contract, not a deployed distribution.

## Next evidence needed

An operator with current deployment context must supply/confirm the generated distribution hostname (or provisioned output) after the recovery and apply gates. Then verify `https://<hostname>/`, `https://<hostname>/api/health`, and the two clean hosted journeys. A non-author must complete their own acceptance run; no such acceptance is claimed here.
