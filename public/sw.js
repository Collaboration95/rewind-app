/* global clients */

// The exporter replaces this marker with the public shell's content identity.
const CACHE_NAME = 'rewind-shell-v3-__BUILD_ID__';
const CACHE_PREFIX = 'rewind-shell-';
const LEGAL_PAGE = /^\/(?:privacy|support|terms)(?:\.html)?$/;
const CORE_SHELL_FILES = [
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

function isPrivateMediaRequest(url) {
  return (
    url.origin === self.location.origin &&
    ['/media/', '/films/', '/clips/'].some((prefix) => url.pathname.startsWith(prefix))
  );
}

function isShellAsset(url) {
  return (
    url.origin === self.location.origin &&
    !url.search &&
    (CORE_SHELL_FILES.includes(url.pathname) ||
      /^\/_expo\/static\/(?:js|css)\/[A-Za-z0-9_./-]+-[a-f0-9]{32}\.(?:js|css)$/.test(url.pathname))
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
  if (
    response.ok &&
    request.method === 'GET' &&
    !/no-store|private/i.test(response.headers.get('Cache-Control') ?? '')
  )
    await cache.put(request, response.clone());
  return response;
}

async function warmShell() {
  const cache = await caches.open(CACHE_NAME);
  try {
    const indexResponse = await fetch('/index.html', { cache: 'no-store', credentials: 'omit' });
    if (!indexResponse.ok || !/text\/html/i.test(indexResponse.headers.get('Content-Type') ?? ''))
      throw new Error('Public shell unavailable.');
    const html = await indexResponse.clone().text();
    const referencedAssets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)]
      .map(([, path]) => path)
      .filter((path) => isShellAsset(new URL(path, self.location.origin)));
    const files = [...new Set([...CORE_SHELL_FILES, ...referencedAssets])].filter(
      (path) => path !== '/index.html',
    );
    // Installation succeeds only with a complete matching shell. A failed
    // upgrade leaves the previous controller and its cache usable.
    await Promise.all(
      files.map(async (path) => {
        const response = await fetch(path, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) throw new Error('Public shell asset unavailable.');
        await cache.put(path, response);
      }),
    );
    await cache.put('/index.html', indexResponse);
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  // Wait for existing app windows to close before activating another build.
  // Do not replace an active worker halfway through recording or uploading.
  event.waitUntil(warmShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (isApiRequest(url) || isPrivateMediaRequest(url) || event.request.method !== 'GET') {
    // Never cache server-backed responses or queue writes for later sync.
    event.respondWith(fetch(event.request).catch(() => apiUnavailableResponse()));
    return;
  }

  // Public legal pages are plain documents: let the browser load them, never
  // the SPA shell, even offline.
  if (url.origin === self.location.origin && LEGAL_PAGE.test(url.pathname)) return;

  if (url.origin === self.location.origin && event.request.mode === 'navigate') {
    // Navigation may carry invite/capability query strings or return JSON/media.
    // It never creates a cache entry. Offline entry uses only the public shell
    // installed with this worker, not another build's global cache.
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html')) ?? cache.match('/offline.html');
      }),
    );
    return;
  }
  if (!isShellAsset(url) || event.request.headers.has('Range')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request, { credentials: 'omit' });
      return cacheResponse(cache, event.request, response);
    }),
  );
});

function reminderIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const valid = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  return value.kind === 'weekly-reminder' && valid(value.groupId) && valid(value.reminderId)
    ? { kind: 'weekly-reminder', groupId: value.groupId, reminderId: value.reminderId }
    : null;
}

self.addEventListener('push', (event) => {
  let intent;
  try {
    intent = reminderIntent(event.data?.json()?.data);
  } catch {
    return;
  }
  if (!intent) return;
  event.waitUntil(
    (async () => {
      // Verify the cookie session and selected group without persisting a private
      // response. Safari revokes subscriptions whose pushes show nothing, so an
      // unverified push (offline, signed out, other group) still shows the same
      // generic text, without the routing intent.
      let verified = false;
      try {
        const response = await fetch('/api/real/groups/current', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        verified = response.ok && (await response.json()).group?.group?.id === intent.groupId;
      } catch {
        /* Revalidate online rather than route into stale private context. */
      }
      await self.registration.showNotification('Rewind', {
        body: 'Your weekly reminder is ready. Open Rewind to check your group.',
        tag: `rewind:${intent.reminderId}`,
        data: verified ? intent : null,
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const intent = reminderIntent(event.notification.data);
  // Unverified reminders carry no data and just open the app; reject malformed data.
  if (!intent && event.notification.data != null) return;
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window' });
      const current = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (current) {
        if (intent) current.postMessage(intent);
        await current.focus();
        return;
      }
      const url = new URL('/', self.location.origin);
      if (intent) {
        url.searchParams.set('rewindReminder', intent.reminderId);
        url.searchParams.set('rewindGroup', intent.groupId);
      }
      await clients.openWindow(url.href);
    })(),
  );
});
