import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('.', import.meta.url));
const provenance = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
const archive = process.argv[2];
assert.ok(archive, 'Usage: node vendor/node-forge/build.mjs <upstream npm tarball>');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
assert.equal(integrity(readFileSync(archive)), provenance.upstream.integrity);
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(vendor, 'rsa.patch')))
    .digest('hex'),
  provenance.patch.sha256,
);

const work = mkdtempSync(join(tmpdir(), 'rewind-forge-backport-'));
try {
  execFileSync('tar', ['-xzf', resolve(archive), '-C', work]);
  const source = join(work, 'package');
  for (const [file, sha256] of Object.entries(provenance.upstream.filesSha256)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(source, file)))
        .digest('hex'),
      sha256,
    );
  }
  execFileSync('patch', ['-p1', '--input', join(vendor, 'rsa.patch')], { cwd: source });
  // Keep both shipped browser bundles. Apply the same nested child-count guard
  // to their pinned minified RSA verification sites; do not drop bundled code.
  for (const [file, change] of Object.entries(provenance.patch.browserBundles)) {
    const before = readFileSync(join(source, file), 'utf8');
    assert.equal(before.split(change.before).length, 2, `Expected one RSA guard in ${file}`);
    writeFileSync(join(source, file), before.replace(change.before, change.after));
  }
  const packagePath = join(source, 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  metadata.name = provenance.fork.name;
  metadata.version = provenance.fork.version;
  metadata.description += ' Rewind local security backport; not an upstream release.';
  metadata.rewindSecurityBackport = {
    upstream: `node-forge@${provenance.upstream.version}`,
    advisory: provenance.patch.advisory,
    upstreamPatchCommit: provenance.patch.commit,
  };
  writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(
    npm,
    ['pack', source, '--offline', '--ignore-scripts', '--pack-destination', vendor],
    {
      stdio: 'inherit',
    },
  );
  assert.equal(
    integrity(readFileSync(join(vendor, provenance.fork.archive))),
    provenance.fork.integrity,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
