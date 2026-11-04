// Bump this version whenever a published shell asset changes.
const CACHE_PREFIX = 'xuri-shell-';
const CACHE_NAME = `${CACHE_PREFIX}2026-11-04-pwa-v1`;
const ASSETS = [
  './index.html', './styles.css', './favicon.svg', './manifest.webmanifest',
  './src/app.js', './src/push-client.js', './src/model.js', './src/storage.js', './src/device-store.js', './src/pwa.js',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
].map((asset) => new URL(asset, self.registration.scope).href);
const INDEX = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // A failed or interrupted install never activates a partial shell.
    const existingCache = (await caches.keys()).includes(CACHE_NAME);
    const cache = await caches.open(CACHE_NAME);
    try { await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))); }
    catch (error) {
      // A worker-only update can share a complete cache with the active worker.
      // Preserve that cache if its replacement download fails.
      if (!existingCache) await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // A waiting update is activated only after the user chooses to update.
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  // Never put business-data responses or requests in the app-shell cache.
  if (/\/api(?:\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const shell = await cache.match(INDEX);
      if (shell) return shell;
      try { return await fetch(request); }
      catch { return new Response('离线资源尚未准备完成，请联网打开一次序日后再试。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    })());
    return;
  }
  const asset = new URL(url.pathname, url.origin).href;
  if (!ASSETS.includes(asset)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(asset) || fetch(request);
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Still show a visible fallback. */ }
  event.waitUntil(self.registration.showNotification('序日提醒', {
    body: typeof data.body === 'string' ? data.body.slice(0, 500) : '有一项日程即将开始，请打开序日查看。',
    icon: new URL('./icons/icon-192.png', self.registration.scope).href,
    badge: new URL('./icons/icon-192.png', self.registration.scope).href,
    tag: `${data.itemId || 'test'}-${data.startAt || ''}-${data.offsetMinutes || 0}`,
    data: { startAt: data.startAt },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('./', self.registration.scope);
  const start = new Date(event.notification.data?.startAt);
  if (Number.isFinite(start.getTime())) target.searchParams.set('date', `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = clients.find((client) => client.url.startsWith(self.registration.scope));
    if (current) { await current.navigate(target.href); await current.focus(); }
    else await self.clients.openWindow(target.href);
  })());
});
