import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appJson = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(
  await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'),
);
const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const offline = await readFile(new URL('../public/offline.html', import.meta.url), 'utf8');

test('Expo web config and manifest describe an installable standalone shell', () => {
  assert.equal(appJson.expo.web.output, 'single');
  assert.equal(appJson.expo.web.display, 'standalone');
  assert.equal(appJson.expo.web.startUrl, '/');
  assert.equal(appJson.expo.web.scope, '/');
  assert.equal(appJson.expo.web.themeColor, manifest.theme_color);
  assert.equal(appJson.expo.web.backgroundColor, manifest.background_color);
  assert.equal(manifest.icons.length, 2);
  assert.deepEqual(
    manifest.icons.map(({ sizes, type }) => ({ sizes, type })),
    [
      { sizes: '192x192', type: 'image/png' },
      { sizes: '512x512', type: 'image/png' },
    ],
  );
});

test('the web shell registers a bounded offline fallback without offline sync', () => {
  assert.match(index, /rel="manifest" href="\/manifest\.json"/);
  assert.match(index, /serviceWorker\.register\('\/sw\.js'/);
  assert.match(
    serviceWorker,
    /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/,
  );
  assert.match(serviceWorker, /runtime_unavailable/);
  assert.match(serviceWorker, /Never cache server-backed responses/);
  assert.match(serviceWorker, /caches\.match\('\/index\.html'\)/);
  const apiGuardIndex = serviceWorker.indexOf('if (isApiRequest(url))');
  const navigationGuardIndex = serviceWorker.indexOf("event.request.mode === 'navigate'");
  const shellAssetGuardIndex = serviceWorker.indexOf('if (!isShellAsset(url)) return;');
  assert.ok(apiGuardIndex >= 0);
  assert.ok(navigationGuardIndex > apiGuardIndex);
  assert.ok(shellAssetGuardIndex > navigationGuardIndex);
  assert.match(offline, /Server-backed actions are unavailable offline/);
  assert.match(offline, /Captured media is not synchronized offline/);
});
