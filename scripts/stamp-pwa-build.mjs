import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cacheDeclaration = /const CACHE_NAME = 'rewind-shell-v3-(?:__BUILD_ID__|[a-f0-9]{24})';/;
const templateDeclaration = "const CACHE_NAME = 'rewind-shell-v3-__BUILD_ID__';";

/** Content identity changes the worker script on every public shell/asset update. */
export async function stampPwaBuild(outputDir) {
  const root = resolve(outputDir);
  const workerPath = resolve(root, 'sw.js');
  const worker = await readFile(workerPath, 'utf8');
  if (!cacheDeclaration.test(worker)) throw new Error('PWA cache marker is missing.');
  const hash = createHash('sha256');
  hash.update(worker.replace(cacheDeclaration, templateDeclaration));
  const index = await readFile(resolve(root, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/(?:src|href)="(\/_expo\/static\/[^"?#]+)"/g)].map(
    ([, path]) => path,
  );
  const paths = [
    ...new Set([
      '/index.html',
      '/offline.html',
      '/manifest.json',
      '/icons/rewind-icon-192.png',
      '/icons/rewind-icon-512.png',
      ...assets,
    ]),
  ].sort();
  for (const path of paths) {
    const absolute = resolve(root, `.${path}`);
    if (!absolute.startsWith(`${root}/`)) throw new Error('Invalid public asset path.');
    hash.update(path);
    hash.update(await readFile(absolute));
  }
  const buildId = hash.digest('hex').slice(0, 24);
  await writeFile(
    workerPath,
    worker.replace(cacheDeclaration, `const CACHE_NAME = 'rewind-shell-v3-${buildId}';`),
  );
  return buildId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const buildId = await stampPwaBuild(process.argv[2] ?? 'dist');
  console.log(`PWA public shell stamped: ${buildId}`);
}
