import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { packageRuntimeDependencies, runtimeRoots } from '../../scripts/runtime-dependencies.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const probe = `
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
// Any accidental network/provider operation fails rather than reaching AWS.
Socket.prototype.connect = () => { throw new Error('Network forbidden'); };
globalThis.fetch = () => { throw new Error('Provider call forbidden'); };
const require = createRequire(import.meta.url);
const roots = ${JSON.stringify(runtimeRoots)};
for (const name of roots) {
  if (process.argv[2] === 'missing') {
    assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
  } else {
    assert.ok(require.resolve(name).startsWith(resolve('node_modules') + '/'));
    await import(name);
  }
}
const { createMediaRuntime } = await import('./server/dist/media/runtime-store.js');
const { createConfiguredReminderProviders } = await import('./server/dist/reminders/providers.js');
const config = { backend: 's3', bucket: 'offline-fixture', expectedBucketOwner: '123456789012', region: 'ap-southeast-1', environment: 'test' };
const curve = createECDH('prime256v1');
curve.setPrivateKey(Buffer.alloc(32, 1));
const vapid = { subject: 'mailto:fixture@example.invalid', publicKey: curve.getPublicKey().toString('base64url'), privateKey: curve.getPrivateKey().toString('base64url') };
if (process.argv[2] === 'missing') {
  await assert.rejects(createMediaRuntime(config), { code: 'sdk_unavailable' });
  await assert.rejects(createConfiguredReminderProviders({ webpush: vapid }), { code: 'ERR_MODULE_NOT_FOUND' });
} else {
  const runtime = await createMediaRuntime(config);
  assert.ok(runtime.uploadTransport);
  runtime.close();
  const providers = await createConfiguredReminderProviders({ webpush: vapid });
  assert.equal(typeof providers.webpush.send, 'function');
  // Exercise the WebPush signing/encryption closure locally.
  const { default: webpush } = await import('web-push');
  const request = webpush.generateRequestDetails({ endpoint: 'https://example.invalid/push', keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } }, 'offline fixture', { vapidDetails: vapid });
  assert.equal(request.method, 'POST');
  assert.ok(request.body.length > 0);
}
`;

function runProbe(directory, mode) {
  const result = spawnSync(process.execPath, ['probe.mjs', mode], {
    cwd: directory,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', AWS_EC2_METADATA_DISABLED: 'true' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('standalone runtime reproduces missing SDKs, then loads the locked minimal provider closure offline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-runtime-packaging-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bare = join(directory, 'bare');
  await cp(join(source, 'server/dist'), join(bare, 'server/dist'), { recursive: true });
  await writeFile(join(bare, 'probe.mjs'), probe);
  runProbe(bare, 'missing');

  const packaged = join(directory, 'packaged');
  const selected = await packageRuntimeDependencies(source, packaged);
  await cp(join(source, 'server/dist'), join(packaged, 'server/dist'), { recursive: true });
  await writeFile(join(packaged, 'probe.mjs'), probe);
  runProbe(packaged, 'packaged');
  const provenance = JSON.parse(
    await readFile(join(packaged, 'node_modules/.rewind-runtime-lock.json')),
  );
  const lockBytes = await readFile(join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  assert.equal(provenance.sourceLockSha256, createHash('sha256').update(lockBytes).digest('hex'));
  assert.deepEqual(provenance.roots, runtimeRoots);
  assert.ok(selected.length < 60);
  for (const key of selected) {
    assert.deepEqual(provenance.packages[key], lock.packages[key]);
    assert.doesNotMatch(key, /(?:expo|react|typescript|jest|eslint|playwright)/);
  }
  assert.ok(selected.includes('node_modules/http_ece'));
  assert.match(
    await readFile(join(packaged, 'node_modules/@aws-sdk/client-s3/LICENSE'), 'utf8'),
    /Apache/,
  );

  // Removing a transitive package must fail at the standalone boundary too.
  await rm(join(packaged, 'node_modules/http_ece'), { recursive: true });
  const broken = spawnSync(process.execPath, ['probe.mjs', 'packaged'], {
    cwd: packaged,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /http_ece/);
});

test('packager fails clearly when a locked transitive dependency is missing or mismatched', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-runtime-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installation = join(directory, 'installation');
  await packageRuntimeDependencies(source, installation);
  await cp(join(source, 'package-lock.json'), join(installation, 'package-lock.json'));
  await cp(
    join(source, 'node_modules/.package-lock.json'),
    join(installation, 'node_modules/.package-lock.json'),
  );
  const manifestPath = join(installation, 'node_modules/http_ece/package.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '0.0.0' }));
  await assert.rejects(
    packageRuntimeDependencies(installation, join(directory, 'bad-version')),
    /version differs from lock.*http_ece/,
  );
  await rm(join(installation, 'node_modules/http_ece'), { recursive: true });
  await assert.rejects(
    packageRuntimeDependencies(installation, join(directory, 'missing')),
    /Missing installed runtime dependency.*http_ece/,
  );
});

test('Docker runtime consumes the closure built from its own npm ci installation', async () => {
  const dockerfile = await readFile(join(source, 'deploy/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY scripts\/runtime-dependencies.mjs/);
  assert.match(dockerfile, /node scripts\/runtime-dependencies.mjs \/app \/runtime-dependencies/);
  assert.match(
    dockerfile,
    /COPY --from=build --chown=rewind:rewind \/runtime-dependencies\/node_modules \.\/node_modules/,
  );
  assert.doesNotMatch(dockerfile, /COPY --from=build[^\n]*\/app\/node_modules/);
});
