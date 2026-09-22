// Great Bend FD service worker. Only handles push notifications and taps on them.
// It deliberately does NOT cache pages, so the app always loads the latest version.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Great Bend FD', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Great Bend FD';
  const options = {
    body: data.body || '',
    icon: 'img/icon-192.png',
    badge: 'img/icon-192.png',
    data: { url: data.url || './index.html' },
    tag: data.tag || undefined
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
