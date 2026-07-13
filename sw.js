// Service worker: app-shell caching for offline/installability,
// plus a message channel that lets the page ask the SW to display
// a system notification (works even if the tab isn't focused, as
// long as the browser process itself hasn't been fully killed by the OS).

const CACHE_NAME = "nearby-reminders-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for app shell, network passthrough for everything else
// (map tiles, geocoding lookups) so the map/search still hit the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin;
  if (!isAppShell) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});

// The page posts a message here to trigger a real system notification
// (sound/vibration/lock-screen banner), rather than calling `new Notification()`
// directly, since showNotification via the SW registration behaves more
// consistently across Android/iOS home-screen apps.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "SHOW_REMINDER_NOTIFICATION") return;

  const { title, body, tag, reminderId } = data.payload || {};

  event.waitUntil(
    self.registration.showNotification(title || "Reminder", {
      body: body || "",
      tag: tag || undefined,
      vibrate: [200, 100, 200, 100, 200],
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      requireInteraction: true,
      data: { reminderId }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: "NOTIFICATION_CLICKED", data: event.notification.data });
      } else {
        self.clients.openWindow("./index.html");
      }
    })
  );
});
