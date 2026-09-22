/* global clients */

const CACHE_NAME = 'rewind-shell-v1';
const CORE_SHELL_FILES = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/icons/rewind-icon-192.png',
  '/icons/rewind-icon-512.png',
];

function isApiRequest(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname === '/api' || url.pathname.startsWith('/api/'))
  );
}

function isShellAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/offline.html' ||
      url.pathname === '/manifest.json' ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/_expo/'))
  );
}

function apiUnavailableResponse() {
  return new Response(
    JSON.stringify({
      error: 'runtime_unavailable',
      message:
        'Server-backed actions are unavailable offline. Reconnect to the local runtime to continue.',
    }),
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      status: 503,
    },
  );
}

async function cacheResponse(cache, request, response) {
  if (response.ok && request.method === 'GET') await cache.put(request, response.clone());
  return response;
}

async function warmShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch('/index.html', { cache: 'no-store' });
  if (indexResponse.ok) {
    await cache.put('/index.html', indexResponse.clone());
    const html = await indexResponse.text();
    const referencedAssets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map(
      ([, path]) => path,
    );
    CORE_SHELL_FILES.push(...referencedAssets);
  }
  await Promise.all(
    [...new Set(CORE_SHELL_FILES)].map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // A partial cache still provides the explicit offline fallback.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    warmShell()
      .catch(() => undefined)
      .finally(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (isApiRequest(url)) {
    // Never cache server-backed responses or queue writes for later sync.
    event.respondWith(fetch(event.request).catch(() => apiUnavailableResponse()));
    return;
  }

  if (url.origin === self.location.origin && event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) =>
          cacheResponse(await caches.open(CACHE_NAME), event.request, response),
        )
        .catch(async () => (await caches.match('/index.html')) ?? caches.match('/offline.html')),
    );
    return;
  }
  if (!isShellAsset(url)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) =>
        caches.open(CACHE_NAME).then((cache) => cacheResponse(cache, event.request, response)),
      );
    }),
  );
});
