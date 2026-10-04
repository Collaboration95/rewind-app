# Rewind node-forge security backport

`rewind-node-forge-1.4.0-rewind.1.tgz` is the local package
`@rewind/node-forge@1.4.0-rewind.1`, installed under the `node-forge` module name
by the root npm override. It is a Rewind-maintained fork, not an official
node-forge release. Both Expo CLI and Expo code-signing certificates use it.
There is no install hook: `npm ci --ignore-scripts` installs the patched code.

The base is the complete npm `node-forge@1.4.0` package. All 59 original files
are retained, including `LICENSE`, original authors/contributors, and both
browser bundles. The license remains **BSD-3-Clause OR GPL-2.0**. Source hashes,
the upstream npm archive integrity, and the fork archive integrity are recorded
in `provenance.json`.

`rsa.patch` backports only the RSA verifier change from
[digitalbazaar/forge PR 1152](https://github.com/digitalbazaar/forge/pull/1152),
pinned at `ceba34402e329f0365134f23fe19898756527d65`. The identical check is
also applied to the two shipped browser bundles at the exact pinned sites
recorded in `provenance.json`. No other executable code changes. The package
name, version, description, and explicit backport metadata identify the fork.
The upstream source maps are retained unchanged and are not regenerated. They
contain only the minimal `AAAA` placeholder mapping and no embedded source
code; source maps cannot execute an unpatched verifier. Both actual executable
bundles receive the guard and are covered by the same forgery rejection and
valid signature tests.

This addresses
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
(CVE-2026-85393): ASN.1 validation ignores surplus nested elements, so RSA
PKCS#1 v1.5 verification must check both the outer DigestInfo count and the
nested DigestAlgorithm count (OID plus optional NULL). As checked on
2026-10-03, npm's latest release was still 1.4.0 and PR 1152 remained unmerged
with no reported CI. Rewind owns this backport until a compatible, verified
upstream release can replace it.

To rebuild with Node 24 and npm 11, download the exact registry package into a
temporary directory, then run the deterministic builder from the repo root:

```sh
npm pack node-forge@1.4.0 --pack-destination /private/tmp
node vendor/node-forge/build.mjs /private/tmp/node-forge-1.4.0.tgz
npm run test:focused -- root tests/node-forge-security.test.mjs
npm audit --omit=dev --audit-level=high
```

The builder verifies the upstream archive, every upstream file, and patch
hash, preserves the package's full contents, and checks the rebuilt archive
integrity. A standard `tar -xzf` exposes all source and bundled files.

The security suite reconstructs the vulnerable baseline from the exact reverse
patch and proves its nested-garbage acceptance, then requires the installed
fork and both bundles to reject a public-key-only low-exponent forgery. It also
checks valid RSA signatures, malformed variants, module resolution from both
Expo consumers, Expo certificate/CSR/manifest signing, and original file hashes.
The existing scaffold root suite imports these tests so the static Quality job
runs them without a workflow change.

The npm audit result applies to the local fork identity and is not an upstream
security certification. Keep monitoring upstream advisories; future fixes to
node-forge will need deliberate backporting or replacement of this fork.
