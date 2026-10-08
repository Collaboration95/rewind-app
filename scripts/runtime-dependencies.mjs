import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The only external imports in server/src are these optional provider SDKs.
export const runtimeRoots = [
  '@aws-sdk/client-cognito-identity-provider',
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  'aws-jwt-verify',
  'pg',
  'web-push',
];
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/** Copy only the locked runtime closure from a trusted npm ci --ignore-scripts
 * installation. Preserve npm's nested layout, package metadata and licenses;
 * never copy nested node_modules implicitly or follow package symlinks. */
export async function packageRuntimeDependencies(source, output) {
  source = resolve(source);
  output = resolve(output);
  const outputRelative = relative(source, output);
  if (outputRelative !== '..' && !outputRelative.startsWith('../'))
    throw new Error('Runtime output must be outside the source installation.');
  const lockBytes = await readFile(join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const installed = await readJson(join(source, 'node_modules/.package-lock.json'));
  if (lock.lockfileVersion !== 3 || installed.lockfileVersion !== 3)
    throw new Error('Runtime packaging requires npm lockfileVersion 3 and npm ci.');
  const selected = new Map();
  function locate(name, parent = '') {
    if (!packageName.test(name)) throw new Error(`Invalid runtime dependency name: ${name}`);
    let directory = parent;
    while (true) {
      const key = `${directory ? directory + '/' : ''}node_modules/${name}`;
      if (lock.packages[key]) return key;
      if (!directory) throw new Error(`Missing locked runtime dependency: ${name} (${parent})`);
      directory = dirname(directory);
      if (directory.endsWith('node_modules')) directory = dirname(directory);
      if (directory === '.') directory = '';
    }
  }
  async function visit(key) {
    if (selected.has(key)) return;
    const entry = lock.packages[key];
    const actual = installed.packages[key];
    if (
      entry.link ||
      !entry.integrity ||
      !actual ||
      ['version', 'resolved', 'integrity'].some((field) => actual[field] !== entry[field])
    )
      throw new Error(`Runtime dependency is not the locked npm ci package: ${key}`);
    const path = join(source, key);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Missing installed runtime dependency: ${key}`);
    const manifest = await readJson(join(path, 'package.json'));
    if (manifest.version !== entry.version)
      throw new Error(`Runtime dependency version differs from lock: ${key}`);
    selected.set(key, entry);
    const dependencies = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[name]?.optional)
        dependencies[name] = entry.peerDependencies[name];
    }
    // Fail closed for optional dependencies too: this closure is pure JS and
    // intentionally portable between the Debian builder and Alpine runtime.
    for (const name of Object.keys(dependencies).sort()) await visit(locate(name, key));
  }
  for (const name of runtimeRoots) {
    if (!lock.packages[''].dependencies?.[name])
      throw new Error(`Runtime root must be a locked production dependency: ${name}`);
    await visit(locate(name));
  }
  // Refuse an existing destination rather than risk deleting unrelated files.
  await mkdir(output);
  for (const [key] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const from = join(source, key);
    await cp(from, join(output, key), {
      recursive: true,
      filter: async (path) => {
        if (path !== from && relative(from, path).split('/').includes('node_modules')) return false;
        if ((await lstat(path)).isSymbolicLink())
          throw new Error(`Unexpected symlink in runtime package: ${relative(source, path)}`);
        return true;
      },
    });
  }
  await writeFile(
    join(output, 'node_modules/.rewind-runtime-lock.json'),
    JSON.stringify(
      {
        lockfileVersion: 3,
        sourceLockSha256: createHash('sha256').update(lockBytes).digest('hex'),
        roots: runtimeRoots,
        packages: Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b))),
      },
      null,
      2,
    ) + '\n',
  );
  return [...selected.keys()].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error('Usage: node scripts/runtime-dependencies.mjs SOURCE OUTPUT');
  const packages = await packageRuntimeDependencies(process.argv[2], process.argv[3]);
  console.log(`Packaged ${packages.length} locked server runtime dependencies.`);
}
