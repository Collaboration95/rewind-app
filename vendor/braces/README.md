# Rewind braces depth-guard backport

`rewind-braces-3.0.3-rewind.1.tgz` is the explicit Rewind-maintained package
`@rewind/braces@3.0.3-rewind.1`, installed under the `braces` module name by a
root file dependency and dollar override. It is not an official upstream
release. Installation needs no lifecycle scripts, and npm installs a physical
package rather than a directory symlink.

This mitigates [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(CVE-2026-93687), stack exhaustion through deeply nested brace patterns. On
2026-10-03 the latest npm release was still 3.0.3, the advisory reported no
patched version, and [upstream PR 72](https://github.com/micromatch/braces/pull/72)
was open and unmerged. Rewind owns maintenance until a compatible, verified
upstream release replaces this fork; audit's recognition of the fork identity
is not upstream security certification.

The package retains all ten original npm files, including the MIT license,
author and contributors. `provenance.json` records the upstream archive
integrity, all original file SHA-256 hashes, patch hash, and fork integrity.
The only executable changes are `depth.patch`, adapted from upstream PR 72
at `d0d575e55e74a4e0218e5248fafb79efc3e54ebb`:

- The parser counts combined brace and parenthesis nesting and throws a
  `SyntaxError` before creating a block deeper than 100.
- Compile, expand and stringify count recursive AST depth, including direct
  caller-supplied ASTs, and throw a deliberate `RangeError` containing
  `exceeds max depth` before exceeding 100. This also bounds child-node cycles.
- A finite `options.maxDepth` may lower the limit; values above 100 cannot
  disable it. Escaped, quoted and square-bracket literals retain their normal
  parser behavior.
- The stringify recursion keeps its original undefined parent argument;
  PR 72's unrelated parent propagation change is omitted to preserve the
  existing `escapeInvalid` output. No other behavior is changed.

Depth errors still need normal caller error handling, just like the existing
length and range errors. This patch prevents engine stack exhaustion; it does
not promise general validation of arbitrary malformed AST objects, total
expansion output limits, or protection against unrelated resource exhaustion.
Patterns exceeding 100 combined nesting levels are intentionally rejected.
The original upstream README is retained unchanged; this document describes
the fork's additional option and compatibility boundary.

Rebuild from the exact npm package using Node 24 and npm 11:

```sh
npm pack braces@3.0.3 --ignore-scripts --pack-destination /private/tmp
node vendor/braces/build.mjs /private/tmp/braces-3.0.3.tgz
npm ci --ignore-scripts
npm run test:fast
npm audit --omit=dev --audit-level=high
```

The deterministic builder verifies the input archive, original files and patch,
then checks the rebuilt archive integrity. The security tests reverse the
patch in a temporary directory and verify every recovered upstream byte before
using that baseline as a negative control. Bounded disposable Node processes
prove the original compile and expand crash under the 10,000-character cap,
then exercise all public string routes, direct AST walkers, malformed nesting,
child cycles, oversized depth options, allowed boundaries and literal syntax.
Lockfile and consumer-resolution assertions ensure micromatch consumers use
the same physical fork. The scaffold suite imports these tests so the static
Quality job runs them without changing the workflow or audit gate.

The complete 899-test upstream suite from the pinned PR commit was also run
with Mocha 11.7.5 and bash-path 2.0.1 in disposable tooling: 857 passed, with
42 existing Bash-comparison failures on this Mac. Running the identical suite
against unpatched 3.0.3 produced those same 42 failures plus five depth-guard
failures. The fork introduced zero additional failures and passed all five
upstream security regressions. This is compatibility comparison evidence,
not a claim that the entire upstream suite is green on this host.
