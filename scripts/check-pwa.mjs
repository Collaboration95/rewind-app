import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDir = resolve(process.argv[2] ?? 'dist');

async function readArtifact(path) {
  return readFile(resolve(distDir, path));
}

function readPngDimensions(buffer, path) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path} is not a PNG`);
  assert.equal(buffer.readUInt32BE(12), 0x49484452, `${path} has no PNG header`);
  return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) };
}

const index = (await readArtifact('index.html')).toString('utf8');
const manifest = JSON.parse((await readArtifact('manifest.json')).toString('utf8'));
const serviceWorker = (await readArtifact('sw.js')).toString('utf8');
const offline = (await readArtifact('offline.html')).toString('utf8');

assert.match(index, /<link rel="manifest" href="\/manifest\.json"/);
assert.match(index, /navigator\.serviceWorker\.register\('\/sw\.js'/);
assert.match(index, /name="theme-color" content="#1D1B1E"/);
assert.match(index, /apple-mobile-web-app-capable/);
assert.equal(manifest.name, 'Rewind');
assert.equal(manifest.short_name, 'Rewind');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.theme_color, '#1D1B1E');
assert.equal(manifest.background_color, '#252326');
assert.equal(manifest.icons.length, 2);

for (const icon of manifest.icons) {
  const dimensions = readPngDimensions(await readArtifact(icon.src.slice(1)), icon.src);
  const expectedSize = Number(icon.sizes.split('x')[0]);
  assert.equal(
    dimensions.width,
    expectedSize,
    `${icon.src} width does not match its manifest size`,
  );
  assert.equal(
    dimensions.height,
    expectedSize,
    `${icon.src} height does not match its manifest size`,
  );
}

assert.match(serviceWorker, /Server-backed actions are unavailable offline/);
assert.match(serviceWorker, /Never cache server-backed responses/);
assert.match(serviceWorker, /caches\.match\('\/index\.html'\)/);
assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*\/api/);
const apiGuardIndex = serviceWorker.indexOf('if (isApiRequest(url))');
const navigationGuardIndex = serviceWorker.indexOf("event.request.mode === 'navigate'");
const shellAssetGuardIndex = serviceWorker.indexOf('if (!isShellAsset(url)) return;');
assert.ok(apiGuardIndex >= 0, 'service worker has no API guard');
assert.ok(navigationGuardIndex > apiGuardIndex, 'navigation must remain behind the API guard');
assert.ok(
  shellAssetGuardIndex > navigationGuardIndex,
  'same-origin navigation must be handled before shell-asset filtering',
);
assert.match(offline, /Captured media is not synchronized offline/);

console.log(`PWA export valid: ${distDir}`);
