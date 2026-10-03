import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  buildEnvironment,
  prepareNativeBuild,
  recordNativeArtifact,
  validateProfiles,
} from '../scripts/native-build.mjs';

const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const eas = JSON.parse(await readFile(new URL('../eas.json', import.meta.url), 'utf8'));
const projectRoot = resolve(new URL('..', import.meta.url).pathname);
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
async function fixture(run) {
  const temp = await mkdtemp('/private/tmp/rewind-native-build-test-');
  const root = join(temp, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'app.json'), JSON.stringify(app));
  await writeFile(join(root, 'eas.json'), JSON.stringify(eas));
  await writeFile(join(root, 'App.tsx'), 'export default function App() { return null; }');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: { expo: '57.0.21' }, scripts: {} }),
  );
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  const base = git(root, 'rev-parse', 'HEAD');
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.git/info/exclude'), 'node_modules\n.env\n');
  const options = {
    projectRoot: root,
    acceptedBase: base,
    outputRoot: join(temp, 'output'),
    apiUrl: 'https://preview.example.invalid/api',
    inviteUrl: 'https://preview.example.invalid',
  };
  try {
    await run({ temp, root, base, options });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('profiles preserve callback, explicit local versions, no OTA and platform/signing separation', () => {
  assert.equal(validateProfiles(app, eas).scheme, 'rewind');
  assert.equal(eas.build['preview-apk'].android.buildType, 'apk');
  assert.equal(eas.build['preview-ios-simulator'].ios.simulator, true);
  assert.equal(eas.build['preview-ios-device'].ios.credentialsSource, 'local');
  for (const key of ['scheme', 'updates']) {
    const changed = structuredClone(app);
    changed.expo[key] = key === 'scheme' ? 'other' : { enabled: true };
    assert.throws(() => validateProfiles(changed, eas));
  }
  const changed = structuredClone(eas);
  changed.build['preview-apk'].developmentClient = true;
  assert.throws(() => validateProfiles(app, changed));
});

test('public origins are explicit HTTPS and reject credentials/query/invite paths', () => {
  assert.equal(
    buildEnvironment('https://api.example.invalid/api/', 'https://web.example.invalid/')
      .EXPO_PUBLIC_LOCAL_BASE_URL,
    'https://api.example.invalid/api',
  );
  for (const value of [
    '/api',
    'http://api.example.invalid',
    'https://u:p@api.example.invalid',
    'https://api.example.invalid/?token=x',
    'https://api.example.invalid/#x',
  ])
    assert.throws(() => buildEnvironment(value, 'https://web.example.invalid'));
  assert.throws(() =>
    buildEnvironment('https://api.example.invalid', 'https://web.example.invalid/invite'),
  );
});

test('staging pins accepted base, source/config/origin and excludes ambient credentials', async () =>
  fixture(async (c) => {
    await writeFile(
      join(c.root, '.env'),
      'EXPO_PUBLIC_LOCAL_BASE_URL=https://wrong.invalid\nEXPO_TOKEN=never-copy',
    );
    const result = await prepareNativeBuild(c.options);
    assert.equal(result.provenance.acceptedBase, c.base);
    assert.equal(result.provenance.sourceCommit, c.base);
    assert.equal(result.provenance.sourceStatus, 'accepted-base');
    assert.equal(result.provenance.outputStatus, 'prepared-not-built');
    for (const digest of ['sourceDigest', 'configDigest', 'originDigest'])
      assert.match(result.provenance[digest], /^[a-f0-9]{64}$/);
    await assert.rejects(readFile(join(result.source, '.env')), { code: 'ENOENT' });
    assert.equal(
      JSON.parse(await readFile(join(result.outputRoot, 'public-env.json')))
        .EXPO_PUBLIC_DEMO_ACCESS,
      'disabled',
    );
    await assert.rejects(prepareNativeBuild(c.options), { code: 'EEXIST' });
  }));

test('unmerged config overlays are labelled preview; unrelated dirty code/dependency changes are refused', async () =>
  fixture(async (c) => {
    const changed = structuredClone(app);
    changed.expo.android.versionCode = 2;
    await writeFile(join(c.root, 'app.json'), JSON.stringify(changed));
    await assert.rejects(prepareNativeBuild(c.options), /Unreviewed changes/);
    const result = await prepareNativeBuild({ ...c.options, overlays: ['app.json'] });
    assert.equal(result.provenance.sourceStatus, 'unmerged-preview');
    await writeFile(join(c.root, 'App.tsx'), 'changed feature');
    await assert.rejects(
      prepareNativeBuild({
        ...c.options,
        outputRoot: join(c.temp, 'another'),
        overlays: ['app.json'],
      }),
      /Unreviewed changes/,
    );
    await assert.rejects(prepareNativeBuild({ ...c.options, overlays: ['App.tsx'] }), /Only #351/);
    await writeFile(
      join(c.root, 'package.json'),
      JSON.stringify({ dependencies: { expo: 'other' }, scripts: {} }),
    );
    await assert.rejects(
      prepareNativeBuild({ ...c.options, overlays: ['package.json'] }),
      /scripts only/,
    );
  }));

test('artifact receipt binds checksum to unchanged source and origins without native acceptance claims', async () =>
  fixture(async (c) => {
    const result = await prepareNativeBuild(c.options);
    const artifact = join(result.outputRoot, 'fixture.apk');
    await writeFile(artifact, Buffer.from('disposable artifact checksum fixture'));
    const recorded = await recordNativeArtifact(result.outputRoot, artifact);
    assert.equal(recorded.outputStatus, 'compiled-unverified-preview');
    assert.equal(recorded.acceptance, 'pending-review-install-and-native-smoke');
    assert.equal(recorded.sourceDigest, result.provenance.sourceDigest);
    assert.match(recorded.artifact.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(recordNativeArtifact(result.outputRoot, artifact), { code: 'EEXIST' });
    await writeFile(join(result.source, 'App.tsx'), 'changed after preparation');
    await assert.rejects(
      recordNativeArtifact(result.outputRoot, artifact),
      /changed after preparation/,
    );
  }));

test('staging rejects source symlinks, unsafe destinations and wrong base', async () =>
  fixture(async (c) => {
    await assert.rejects(
      prepareNativeBuild({ ...c.options, outputRoot: join(c.root, 'output') }),
      /external disposable/,
    );
    await assert.rejects(
      prepareNativeBuild({ ...c.options, acceptedBase: 'no-sha' }),
      /exact accepted base/,
    );
    await assert.rejects(prepareNativeBuild({ ...c.options, acceptedBase: 'a'.repeat(40) }));
    await symlink(join(c.root, 'App.tsx'), join(c.root, 'linked.ts'));
    git(c.root, 'add', 'linked.ts');
    await assert.rejects(
      prepareNativeBuild({ ...c.options }),
      /Native source inputs|Unreviewed changes/,
    );
  }));
