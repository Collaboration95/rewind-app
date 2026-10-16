import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

assert.equal(
  process.platform,
  'linux',
  'Isolation check must run inside the offline Linux container',
);
assert.equal(process.getuid(), 1000, 'Container must run as the unprivileged fixture user');
assert.ok(
  Object.keys(networkInterfaces()).every((name) => name === 'lo'),
  'Offline container has an external network interface',
);
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m, 'Container has effective capabilities');
assert.match(status, /^NoNewPrivs:\s+1$/m, 'Privilege escalation is allowed');
await assert.rejects(writeFile('/opt/scan/write-probe', 'test'), /EROFS|EACCES/);
await assert.rejects(access('/opt/scan/server'));
await assert.rejects(access('/opt/scan/.git'));
assert.match(
  await readFile('/etc/ssl/certs/ca-certificates.crt', 'utf8'),
  /BEGIN CERTIFICATE/,
  'Provider HTTPS trust store is missing',
);
// Exercise the npm launcher and binary extraction under the actual memory/tmpfs bounds.
execFileSync(process.execPath, ['node_modules/@vigolium/vigolium/bin/vigolium.js', '--help'], {
  timeout: 30_000,
  stdio: 'pipe',
});
const checks = {
  status: 'verified-offline',
  nonRoot: true,
  readOnlyApplicationFilesystem: true,
  effectiveCapabilities: false,
  privilegeEscalation: false,
  externalNetworkInterface: false,
  applicationSourcePresent: false,
  gitDirectoryPresent: false,
  scannerBinaryStarts: true,
  httpsTrustStorePresent: true,
  providerContacted: false,
};
await writeFile(resolve('/reports/isolation.json'), JSON.stringify(checks, null, 2));
console.log('Offline container isolation and scanner binary checks passed.');
