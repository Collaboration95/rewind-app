import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildEnvironment,
  prepareNativeBuild,
  recordNativeArtifact,
  validateProfiles,
  verifyAndroidBundleSources,
} from '../scripts/native-build.mjs';

const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const eas = JSON.parse(await readFile(new URL('../eas.json', import.meta.url), 'utf8'));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
async function fixture(run) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'rewind-native-build-test-')));
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
    '-c',
    'core.hooksPath=/dev/null',
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
    assert.equal(
      createRequire(join(result.source, 'package.json')).resolve(result.source),
      join(result.source, result.provenance.generatedBuildInputs.entrypoint),
    );
    assert.equal(JSON.parse(await readFile(join(c.root, 'package.json'))).main, undefined);
    assert.match(result.provenance.buildSourceDigest, /^[a-f0-9]{64}$/);
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
    const maps = join(result.source, 'android/app/build/intermediates/sourcemaps/react/release');
    await mkdir(maps, { recursive: true });
    await writeFile(
      join(maps, 'index.android.bundle.packager.map'),
      JSON.stringify({
        sources: ['/App.tsx'],
        sourcesContent: [await readFile(join(result.source, 'App.tsx'), 'utf8')],
      }),
    );
    const artifact = join(result.outputRoot, 'fixture.apk');
    await writeFile(artifact, Buffer.from('disposable artifact checksum fixture'));
    const generated = join(result.source, 'android/app/build/generated/assets/react/release');
    await mkdir(generated, { recursive: true });
    await writeFile(join(generated, 'index.android.bundle'), 'synthetic generated bundle');
    await assert.rejects(recordNativeArtifact(result.outputRoot, artifact), /embedded bundle/);
    const assets = join(result.outputRoot, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'index.android.bundle'), 'unrelated bundle');
    await rm(artifact);
    execFileSync('zip', ['-q', artifact, 'assets/index.android.bundle'], {
      cwd: result.outputRoot,
    });
    await assert.rejects(recordNativeArtifact(result.outputRoot, artifact), /differs from/);
    await writeFile(join(assets, 'index.android.bundle'), 'synthetic generated bundle');
    execFileSync('zip', ['-q', artifact, 'assets/index.android.bundle'], {
      cwd: result.outputRoot,
    });
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
      prepareNativeBuild({ ...c.options, outputRoot: join(c.root, '..preview') }),
      /external disposable/,
    );
    const link = join(c.temp, 'inside-link');
    await symlink(c.root, link);
    await assert.rejects(
      prepareNativeBuild({ ...c.options, outputRoot: join(link, 'preview') }),
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

test('bundle receipt refuses foreign shared-tree code and changed staged application content', async () =>
  fixture(async (c) => {
    const result = await prepareNativeBuild(c.options);
    const maps = join(result.source, 'android/app/build/intermediates/sourcemaps/react/release');
    await mkdir(maps, { recursive: true });
    const mapPath = join(maps, 'index.android.bundle.packager.map');
    await writeFile(
      mapPath,
      JSON.stringify({ sources: ['/../../shared-fixture/App.tsx'], sourcesContent: ['foreign'] }),
    );
    await assert.rejects(verifyAndroidBundleSources(result.source), /outside the staged snapshot/);
    await writeFile(
      mapPath,
      JSON.stringify({ sources: ['/App.tsx'], sourcesContent: ['foreign'] }),
    );
    await assert.rejects(
      verifyAndroidBundleSources(result.source),
      /differs from the staged snapshot/,
    );
    await writeFile(
      mapPath,
      JSON.stringify({
        sources: ['/node_modules/expo/AppEntry.js'],
        sourcesContent: ['dependency'],
      }),
    );
    await assert.rejects(
      verifyAndroidBundleSources(result.source),
      /Missing native application sources/,
    );
  }));

test('bundle verification refuses a source replaced by a symlink after its descriptor opens', async () =>
  fixture(async (c) => {
    const result = await prepareNativeBuild(c.options);
    const candidate = join(result.source, 'App.tsx');
    const maps = join(result.source, 'android/app/build/intermediates/sourcemaps/react/release');
    await mkdir(maps, { recursive: true });
    await writeFile(
      join(maps, 'index.android.bundle.packager.map'),
      JSON.stringify({
        sources: ['/App.tsx'],
        sourcesContent: [await readFile(candidate, 'utf8')],
      }),
    );
    const foreign = join(c.temp, 'foreign.tsx');
    await writeFile(foreign, 'outside snapshot');
    const originalOpen = fsPromises.open;
    let swapped = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === candidate && !swapped) {
        swapped = true;
        await rm(candidate);
        await symlink(foreign, candidate);
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(verifyAndroidBundleSources(result.source), /changed while reading/);
      assert.equal(swapped, true);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
  }));
