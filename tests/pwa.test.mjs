import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { stampPwaBuild } from '../scripts/stamp-pwa-build.mjs';

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
  assert.equal(manifest.theme_color, manifest.background_color);
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
  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(index, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(index, /name="theme-color" content="#252326"/);
  assert.match(index, /background: #252326/);
  assert.match(index, /min-height: 100dvh/);
  assert.match(index, /margin: 0/);
  assert.match(serviceWorker, /const CACHE_NAME = 'rewind-shell-v3-__BUILD_ID__'/);
  assert.match(
    serviceWorker,
    /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/,
  );
  assert.match(serviceWorker, /runtime_unavailable/);
  assert.match(serviceWorker, /Never cache server-backed responses/);
  assert.match(serviceWorker, /cache\.match\('\/index\.html'\)/);
  const apiGuardIndex = serviceWorker.indexOf('if (isApiRequest(url)');
  const navigationGuardIndex = serviceWorker.indexOf("event.request.mode === 'navigate'");
  const shellAssetGuardIndex = serviceWorker.indexOf('if (!isShellAsset(url)');
  assert.ok(apiGuardIndex >= 0);
  assert.ok(navigationGuardIndex > apiGuardIndex);
  assert.ok(shellAssetGuardIndex > navigationGuardIndex);
  assert.match(offline, /Server-backed actions are unavailable offline/);
  assert.match(offline, /Captured media is not synchronized offline/);
  assert.match(offline, /min-height: 100dvh/);
  assert.match(offline, /margin: 0/);
});

function workerFixture(source = serviceWorker, stores = new Map()) {
  const handlers = new Map();
  const network = new Map();
  const calls = [];
  const origin = 'https://rewind.invalid';
  const key = (input) => new URL(typeof input === 'string' ? input : input.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async put(request, response) {
          entries.set(key(request), response.clone());
        },
        async match(request) {
          return entries.get(key(request))?.clone();
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request) {
      for (const entries of stores.values()) {
        if (entries.has(key(request))) return entries.get(key(request)).clone();
      }
    },
  };
  let claimed = 0;
  let skipped = 0;
  const self = {
    location: { origin },
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    skipWaiting() {
      skipped++;
    },
  };
  runInNewContext(source, {
    self,
    caches,
    URL,
    Response,
    clients: {
      async claim() {
        claimed++;
      },
    },
    async fetch(input, options) {
      calls.push({ url: key(input), options, method: input.method ?? 'GET' });
      const response = network.get(key(input));
      if (!response || response instanceof Error) throw new Error('offline');
      return response.clone();
    },
  });
  const serve = (path, body, type = 'text/html', headers = {}) =>
    network.set(key(path), new Response(body, { headers: { 'Content-Type': type, ...headers } }));
  const installShell = (build = 'old') => {
    serve(
      '/index.html',
      `<script src="/_expo/static/js/web/AppEntry-${'a'.repeat(32)}.js"></script><main>${build}</main>`,
    );
    serve('/offline.html', 'offline');
    serve('/manifest.json', '{}', 'application/json');
    serve('/icons/rewind-icon-192.png', 'icon', 'image/png');
    serve('/icons/rewind-icon-512.png', 'icon', 'image/png');
    serve(`/_expo/static/js/web/AppEntry-${'a'.repeat(32)}.js`, build, 'application/javascript');
  };
  return {
    stores,
    calls,
    network,
    serve,
    installShell,
    get claimed() {
      return claimed;
    },
    get skipped() {
      return skipped;
    },
    async lifecycle(name) {
      let pending;
      handlers.get(name)({
        waitUntil(promise) {
          pending = promise;
        },
      });
      await pending;
    },
    async request(path, { method = 'GET', mode = 'cors', headers = {} } = {}) {
      let response;
      const request = { url: key(path), method, mode, headers: new Headers(headers) };
      handlers.get('fetch')({
        request,
        respondWith(promise) {
          response = promise;
        },
      });
      return response ? await response : undefined;
    },
  };
}

test('private API/media, invite query navigations and writes never enter the shell cache', async () => {
  const worker = workerFixture();
  worker.installShell();
  await worker.lifecycle('install');
  const before = [...worker.stores.values()].flatMap((entries) => [...entries.keys()]);
  for (const path of [
    '/api/real/current',
    '/media/access/private-token',
    '/clips/private/download',
    '/private-metadata',
    '/invite?code=private-code',
  ]) {
    worker.serve(path, 'private-data', 'video/mp4', { 'Cache-Control': 'no-store' });
    assert.equal(await (await worker.request(path, { mode: 'navigate' })).text(), 'private-data');
  }
  worker.serve('/api/real/current', 'accepted', 'application/json');
  await worker.request('/api/real/current', { method: 'POST' });
  assert.deepEqual(
    [...worker.stores.values()].flatMap((entries) => [...entries.keys()]),
    before,
  );
  worker.network.clear();
  const offline = await worker.request('/media/access/private-token', { mode: 'navigate' });
  assert.equal(offline.status, 503);
  assert.match(await offline.text(), /runtime_unavailable/);
  assert.equal((await worker.request('/api/real/current', { method: 'POST' })).status, 503);
  assert.equal(worker.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(worker.skipped, 0);
});

test('offline entry uses its installed build; an incomplete upgrade preserves the previous cache', async () => {
  const oldWorker = workerFixture(serviceWorker.replace('__BUILD_ID__', 'a'.repeat(24)));
  oldWorker.installShell('old-build');
  await oldWorker.lifecycle('install');
  oldWorker.stores.set('another-app-cache', new Map());
  const nextSource = serviceWorker.replace('__BUILD_ID__', 'b'.repeat(24));
  const nextWorker = workerFixture(nextSource, oldWorker.stores);
  nextWorker.installShell('next-build');
  nextWorker.network.delete('https://rewind.invalid/icons/rewind-icon-512.png');
  await assert.rejects(nextWorker.lifecycle('install'), /offline/);
  assert.equal(oldWorker.stores.has(`rewind-shell-v3-${'a'.repeat(24)}`), true);
  assert.equal(oldWorker.stores.has(`rewind-shell-v3-${'b'.repeat(24)}`), false);
  oldWorker.network.clear();
  assert.match(
    await (await oldWorker.request('/groups/group/capsule', { mode: 'navigate' })).text(),
    /old-build/,
  );
  nextWorker.installShell('next-build');
  await nextWorker.lifecycle('install');
  assert.equal(nextWorker.skipped, 0);
  assert.equal(oldWorker.stores.has(`rewind-shell-v3-${'a'.repeat(24)}`), true);
  await nextWorker.lifecycle('activate');
  assert.equal(nextWorker.claimed, 1);
  assert.equal(oldWorker.stores.has(`rewind-shell-v3-${'a'.repeat(24)}`), false);
  assert.equal(oldWorker.stores.has('another-app-cache'), true);
  nextWorker.network.clear();
  assert.match(
    await (await nextWorker.request('/invite?code=code', { mode: 'navigate' })).text(),
    /next-build/,
  );
});

test('public asset misses omit credentials and no-store responses are not cached', async () => {
  const worker = workerFixture();
  const asset = `/_expo/static/js/web/AppEntry-${'b'.repeat(32)}.js`;
  worker.serve(asset, 'private-response', 'application/javascript', {
    'Cache-Control': 'no-store',
  });
  assert.equal(await (await worker.request(asset)).text(), 'private-response');
  assert.equal(worker.calls[0].options.credentials, 'omit');
  assert.equal(
    [...worker.stores.values()].every((entries) => entries.size === 0),
    true,
  );
  assert.equal(await worker.request(`${asset}?capability=secret`), undefined);
  assert.equal(await worker.request(asset, { headers: { Range: 'bytes=0-9' } }), undefined);
});

test('export stamping is deterministic and changes on asset content without import-time writes', async () => {
  const root = await mkdtemp(`${tmpdir()}/rewind-pwa-build-`);
  try {
    await mkdir(resolve(root, 'icons'));
    await mkdir(resolve(root, '_expo/static/js/web'), { recursive: true });
    const asset = `/_expo/static/js/web/AppEntry-${'a'.repeat(32)}.js`;
    for (const path of [
      'offline.html',
      'manifest.json',
      'icons/rewind-icon-192.png',
      'icons/rewind-icon-512.png',
    ])
      await writeFile(resolve(root, path), path);
    await writeFile(resolve(root, 'index.html'), `<script src="${asset}"></script>`);
    await writeFile(resolve(root, `.${asset}`), 'first-build');
    await writeFile(resolve(root, 'sw.js'), serviceWorker);
    const first = await stampPwaBuild(root);
    assert.match(first, /^[a-f0-9]{24}$/);
    assert.equal(await stampPwaBuild(root), first);
    assert.match(await readFile(resolve(root, 'sw.js'), 'utf8'), new RegExp(first));
    await writeFile(resolve(root, `.${asset}`), 'second-build');
    assert.notEqual(await stampPwaBuild(root), first);
    await rm(resolve(root, `.${asset}`));
    await assert.rejects(stampPwaBuild(root), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
