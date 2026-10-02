import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { assertStaticArtifact } from './production-web-proxy.mjs';
import { stampPwaBuild } from './stamp-pwa-build.mjs';

const MANIFEST_NAME = '.rewind-build-artifact.json';
const MANIFEST_SCHEMA = 1;
const OUTPUT_ID = 'expo-web-static-v1';

function run(command, args, { cwd, env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

function trackedAndDirtyFiles(projectRoot) {
  const encoded = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: projectRoot, encoding: 'buffer' },
  );
  const files = encoded.toString('utf8').split('\0').filter(Boolean);
  return [
    ...new Set([...files, '.env', '.env.local', '.env.production', '.env.production.local']),
  ].sort();
}

async function hashInputs(projectRoot, files) {
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    const absolute = resolve(projectRoot, path);
    if (!absolute.startsWith(`${resolve(projectRoot)}/`)) {
      throw new Error(`Build input escapes the project root: ${path}`);
    }
    try {
      const details = await lstat(absolute);
      hash.update(String(details.mode & 0o777));
      if (details.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(await readlink(absolute));
        const target = await stat(absolute);
        if (target.isFile()) {
          hash.update('file\0');
          hash.update(await readFile(absolute));
        } else if (target.isDirectory()) {
          hash.update('directory\0');
        } else {
          hash.update('special\0');
        }
      } else if (details.isFile()) {
        hash.update('file\0');
        hash.update(await readFile(absolute));
      } else if (details.isDirectory()) {
        hash.update('directory\0');
      } else {
        hash.update('special\0');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('missing\0');
    }
  }
  return hash.digest('hex');
}

function publicEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => name.startsWith('EXPO_PUBLIC_'))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function productionE2eBuildEnv(source = process.env) {
  const env = {
    ...source,
    EXPO_PUBLIC_CAMERA_MODE: 'demo',
    EXPO_PUBLIC_LOCAL_BASE_URL: '/api',
  };
  delete env.EXPO_PUBLIC_DEMO_ACCESS;
  return env;
}

export async function computeBuildArtifactKey({
  projectRoot,
  env,
  mode,
  output = OUTPUT_ID,
  files = trackedAndDirtyFiles(projectRoot),
}) {
  const sourceDigest = await hashInputs(projectRoot, await files);
  const fingerprint = {
    schema: MANIFEST_SCHEMA,
    sourceDigest,
    publicEnvironment: publicEnvironment(env),
    mode,
    output,
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

async function artifactIntegrity(artifactDir) {
  const hash = createHash('sha256');
  let files = 0;
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!prefix && entry.name === MANIFEST_NAME) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        hash.update(`directory\0${path}\0`);
        await visit(absolute, path);
      } else if (entry.isFile()) {
        hash.update(`file\0${path}\0`);
        hash.update(await readFile(absolute));
        files += 1;
      } else {
        throw new Error(`Artifact contains an unsupported entry: ${path}`);
      }
    }
  }
  await visit(artifactDir);
  return { sha256: hash.digest('hex'), files };
}

async function pwaBuildId(artifactDir) {
  const worker = await readFile(join(artifactDir, 'sw.js'), 'utf8');
  return worker.match(/const CACHE_NAME = 'rewind-shell-v3-([a-f0-9]{24})';/)?.[1] ?? null;
}

export async function verifyBuildArtifact(artifactDir, expectedKey, output = OUTPUT_ID) {
  try {
    const manifest = JSON.parse(await readFile(join(artifactDir, MANIFEST_NAME), 'utf8'));
    if (
      manifest.schema !== MANIFEST_SCHEMA ||
      manifest.key !== expectedKey ||
      manifest.output !== output ||
      !/^[a-f0-9]{24}$/.test(manifest.buildId)
    ) {
      return false;
    }
    const [integrity, actualBuildId] = await Promise.all([
      artifactIntegrity(artifactDir),
      pwaBuildId(artifactDir),
    ]);
    await assertStaticArtifact(artifactDir);
    return (
      integrity.sha256 === manifest.integrity?.sha256 &&
      integrity.files === manifest.integrity?.files &&
      actualBuildId === manifest.buildId
    );
  } catch {
    return false;
  }
}

export async function ensureBuildArtifact({
  projectRoot,
  cacheRoot,
  env,
  mode = 'production-e2e-demo',
  output = OUTPUT_ID,
  build,
  log = console.log,
}) {
  const root = resolve(projectRoot);
  const cache = resolve(cacheRoot);
  await mkdir(cache, { recursive: true });
  const key = await computeBuildArtifactKey({ projectRoot: root, env, mode, output });
  const artifactDir = join(cache, key);
  if (await verifyBuildArtifact(artifactDir, key, output)) {
    const currentKey = await computeBuildArtifactKey({ projectRoot: root, env, mode, output });
    if (currentKey !== key) {
      throw new Error('Production E2E source changed while verifying the cached web artifact.');
    }
    const buildId = await pwaBuildId(artifactDir);
    log(`Production E2E web artifact cache hit: ${key.slice(0, 12)} (${buildId}).`);
    return { artifactDir, key, buildId, cacheHit: true };
  }

  await rm(artifactDir, { recursive: true, force: true });
  const stagingDir = await mkdtemp(join(cache, `.artifact-${key.slice(0, 12)}-`));
  const startedAt = performance.now();
  try {
    if (build) {
      await build(stagingDir);
    } else {
      const expoCli = join(root, 'node_modules/expo/bin/cli');
      await run(
        process.execPath,
        [expoCli, 'export', '--clear', '--platform', 'web', '--output-dir', stagingDir],
        { cwd: root, env },
      );
    }
    const buildId = await stampPwaBuild(stagingDir);
    const postBuildKey = await computeBuildArtifactKey({ projectRoot: root, env, mode, output });
    if (postBuildKey !== key) {
      throw new Error(
        'Production E2E source changed during the web export; refusing to publish it.',
      );
    }
    await assertStaticArtifact(stagingDir);
    const integrity = await artifactIntegrity(stagingDir);
    await writeFile(
      join(stagingDir, MANIFEST_NAME),
      `${JSON.stringify({ schema: MANIFEST_SCHEMA, key, output, buildId, integrity }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const prePublishKey = await computeBuildArtifactKey({ projectRoot: root, env, mode, output });
    if (prePublishKey !== key) {
      throw new Error('Production E2E source changed before web artifact publication.');
    }
    await rename(stagingDir, artifactDir);
    log(
      `Production E2E web artifact built: ${key.slice(0, 12)} (${buildId}) in ${(
        (performance.now() - startedAt) /
        1000
      ).toFixed(2)}s.`,
    );
    return { artifactDir, key, buildId, cacheHit: false };
  } catch (error) {
    await rm(artifactDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
