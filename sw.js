/* Nova service worker — opens instantly, works offline, and shows notifications.
   Serves the saved copy first, then quietly fetches a fresh one for next time.
   Bump VERSION whenever files change so old copies get cleared. */
const VERSION = 'nova-8';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});

/* Notifications */
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { title: 'Nova', body: e.data ? e.data.text() : '' }; }
  const title = m.title || 'Nova';
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: m.body || '', tag: m.tag || undefined, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: m.url || '/' }
    });
    // If Nova is open, show it inside the app too
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'nova-push', title, body: m.body || '' }));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
