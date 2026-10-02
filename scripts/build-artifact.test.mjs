import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  computeBuildArtifactKey,
  ensureBuildArtifact,
  verifyBuildArtifact,
} from './build-artifact.mjs';

async function createProject(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rewind-build-key-test-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'rewind-build-cache-test-'));
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  await writeFile(join(projectRoot, 'App.tsx'), 'export default 1;\n');
  await writeFile(join(projectRoot, 'app.json'), '{"expo":{"name":"Test"}}\n');
  await writeFile(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  execFileSync('git', ['add', 'App.tsx', 'app.json', 'package-lock.json'], { cwd: projectRoot });
  t.after(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  return { projectRoot, cacheRoot };
}

async function writeWebArtifact(outputDir, source = 'fixture') {
  await mkdir(join(outputDir, 'icons'), { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, 'index.html'), `<!doctype html><title>${source}</title>`),
    writeFile(join(outputDir, 'offline.html'), '<!doctype html><title>Offline</title>'),
    writeFile(join(outputDir, 'manifest.json'), '{}\n'),
    writeFile(join(outputDir, 'icons/rewind-icon-192.png'), 'icon-192'),
    writeFile(join(outputDir, 'icons/rewind-icon-512.png'), 'icon-512'),
    writeFile(join(outputDir, 'sw.js'), "const CACHE_NAME = 'rewind-shell-v3-__BUILD_ID__';\n"),
  ]);
}

test('artifact key hashes dirty tracked source and lockfile content', async (t) => {
  const { projectRoot } = await createProject(t);
  const inputs = { projectRoot, env: {}, mode: 'production-e2e-demo' };
  const original = await computeBuildArtifactKey(inputs);

  await writeFile(join(projectRoot, 'App.tsx'), 'export default 2;\n');
  const dirtySource = await computeBuildArtifactKey(inputs);
  assert.notEqual(dirtySource, original);

  await writeFile(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3,"dirty":true}\n');
  const dirtyLock = await computeBuildArtifactKey(inputs);
  assert.notEqual(dirtyLock, dirtySource);
  await writeFile(join(projectRoot, 'app.json'), '{"expo":{"name":"Changed"}}\n');
  assert.notEqual(await computeBuildArtifactKey(inputs), dirtyLock);
});

test('public Expo environment, mode, and output all invalidate the artifact key', async (t) => {
  const { projectRoot } = await createProject(t);
  const base = {
    projectRoot,
    env: { EXPO_PUBLIC_LOCAL_BASE_URL: '/api', PRIVATE_RUNTIME_VALUE: 'ignored' },
    mode: 'production-e2e-demo',
    output: 'expo-web-static-v1',
  };
  const key = await computeBuildArtifactKey(base);
  assert.notEqual(
    await computeBuildArtifactKey({
      ...base,
      env: { ...base.env, EXPO_PUBLIC_CAMERA_MODE: 'demo' },
    }),
    key,
  );
  assert.notEqual(await computeBuildArtifactKey({ ...base, mode: 'release' }), key);
  assert.notEqual(await computeBuildArtifactKey({ ...base, output: 'expo-web-static-v2' }), key);
});

test('one compatible artifact is built once and reused only after integrity verification', async (t) => {
  const { projectRoot, cacheRoot } = await createProject(t);
  let builds = 0;
  const logs = [];
  const options = {
    projectRoot,
    cacheRoot,
    env: { EXPO_PUBLIC_LOCAL_BASE_URL: '/api' },
    build: async (outputDir) => {
      builds += 1;
      await writeWebArtifact(outputDir);
    },
    log: (message) => logs.push(message),
  };

  const first = await ensureBuildArtifact(options);
  const second = await ensureBuildArtifact(options);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.key, second.key);
  assert.equal(first.artifactDir, second.artifactDir);
  assert.equal(builds, 1);
  assert.equal(await verifyBuildArtifact(first.artifactDir, first.key), true);
  assert.equal(
    logs.some((message) => message.includes('cache hit')),
    true,
  );
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_RUNTIME_VALUE/);
});

test('a missing or corrupt artifact is rebuilt rather than reused', async (t) => {
  const { projectRoot, cacheRoot } = await createProject(t);
  let builds = 0;
  const options = {
    projectRoot,
    cacheRoot,
    env: {},
    build: async (outputDir) => {
      builds += 1;
      await writeWebArtifact(outputDir, `fixture-${builds}`);
    },
    log: () => {},
  };

  const first = await ensureBuildArtifact(options);
  assert.equal(
    await readFile(join(first.artifactDir, 'index.html'), 'utf8'),
    '<!doctype html><title>fixture-1</title>',
  );
  await writeFile(join(first.artifactDir, 'index.html'), 'corrupt');
  assert.equal(await verifyBuildArtifact(first.artifactDir, first.key), false);

  const rebuilt = await ensureBuildArtifact(options);
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(builds, 2);
  assert.equal(await verifyBuildArtifact(rebuilt.artifactDir, rebuilt.key), true);
  assert.equal(
    await readFile(join(rebuilt.artifactDir, 'index.html'), 'utf8'),
    '<!doctype html><title>fixture-2</title>',
  );

  await rm(rebuilt.artifactDir, { recursive: true, force: true });
  assert.equal(await verifyBuildArtifact(rebuilt.artifactDir, rebuilt.key), false);
  const restored = await ensureBuildArtifact(options);
  assert.equal(restored.cacheHit, false);
  assert.equal(builds, 3);
});

test('failed artifact builds preserve the error and clean their staging directory', async (t) => {
  const { projectRoot, cacheRoot } = await createProject(t);
  await assert.rejects(
    ensureBuildArtifact({
      projectRoot,
      cacheRoot,
      env: {},
      build: async () => {
        throw new Error('fixture build failed');
      },
      log: () => {},
    }),
    /fixture build failed/,
  );
  assert.deepEqual(await readdir(cacheRoot), []);
});
