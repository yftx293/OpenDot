/* Notification delivery only. No fetch handler, offline page, or data cache. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const app = new URL('../', self.registration.scope);
      const target = new URL('chat', app);
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Only focus this application's windows, never another same-origin app.
      for (const client of clients) {
        const url = new URL(client.url);
        if (
          url.origin === app.origin &&
          url.pathname.startsWith(app.pathname)
        ) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
