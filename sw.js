// Wick Engine service worker: after the first load, everything the site needs is cached, so it runs offline.
// build.sh (and the Pages deploy) write files.json, the list of every file the site serves; install caches all of them.
// Engine files are served from the cache and refreshed in the background (the update shows on the next load).
// game/ and files.json try the network first, so a redeployed game is picked up as soon as you are online.

const VERSION = 'p0.3.0';
const CACHE = `wick-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let list = [];
    try {
      const res = await fetch('files.json', { cache: 'no-cache' });
      if (res.ok) { list = await res.json(); await cache.put('files.json', res.clone()); }
    } catch { /* offline install: whatever is already cached keeps working */ }
    const wanted = ['./', 'index.html', 'manifest.json', ...list];
    // One at a time results, not addAll: a single missing optional file must not stop everything else being cached.
    const results = await Promise.allSettled(wanted.map(async (path) => {
      const res = await fetch(path, { cache: 'reload' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      await cache.put(path, res);
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) console.warn(`Wick offline cache: ${failed.length} file(s) could not be cached`, failed.map((f) => f.reason?.message));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('wick-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const networkFirst = async (request) => {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? Response.error();
  }
};

const staleWhileRevalidate = async (request, event) => {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request).then((res) => { if (res.ok && res.type === 'basic') cache.put(request, res.clone()); return res; }).catch(() => null);
  if (cached) { event.waitUntil(refresh); return cached; }
  return (await refresh) ?? Response.error();
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (request.mode === 'navigate') {
    // Any address inside the site opens the app shell, online or not.
    event.respondWith((async () => (await (await caches.open(CACHE)).match('index.html')) ?? fetch(request))());
    return;
  }
  if (path.includes('/game/') || path.endsWith('/files.json')) { event.respondWith(networkFirst(request)); return; }
  event.respondWith(staleWhileRevalidate(request, event));
});
