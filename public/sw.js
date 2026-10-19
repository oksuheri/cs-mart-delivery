const CACHE_NAME = 'csmart-pwa-v8';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/assets/logo.jpg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-apple-touch.png',
  '/assets/icon-maskable-512.png',
  '/assets/badge-96.png',
  '/assets/promo_banner_1.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching app shell & assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // If API request, try network first
  if (requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Return offline JSON message if offline
        return new Response(JSON.stringify({
          error: "offline",
          message: "Perangkat sedang offline atau server backend belum aktif."
        }), {
          status: 503,
          statusText: "Service Unavailable",
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Static shell request - cache first then network fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      });
    })
  );
});

// Push notification listener
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'CS Mart Delivery', body: 'Pembaruan pesanan terbaru' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icon-192.png',
      badge: '/assets/badge-96.png',
      vibrate: [100, 50, 100],
      tag: 'csmart-order-update'
    })
  );
});

// Message listener from app (for badging & home screen notification dot)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_BADGE') {
    const count = Number(event.data.count || 0);

    // 1. Service Worker Badging API
    if ('setAppBadge' in self.registration) {
      if (count > 0) {
        self.registration.setAppBadge(count).catch(() => {});
      } else {
        self.registration.clearAppBadge().catch(() => {});
      }
    }
    if ('setAppBadge' in navigator) {
      if (count > 0) {
        navigator.setAppBadge(count).catch(() => {});
      } else {
        navigator.clearAppBadge().catch(() => {});
      }
    }

    // 2. Android Home Screen Notification Dot Trigger:
    // Android launcher places the badge dot on the home screen icon ONLY when a system notification is active!
    if (count > 0) {
      self.registration.showNotification(event.data.title || 'CS Mart Delivery', {
        body: event.data.body || `Ada ${count} notifikasi & promo baru`,
        icon: '/assets/icon-192.png',
        badge: '/assets/badge-96.png',
        tag: 'csmart-badge-notification',
        renotify: false,
        silent: true
      }).catch(() => {});
    } else {
      self.registration.getNotifications({ tag: 'csmart-badge-notification' }).then(notifs => {
        notifs.forEach(n => n.close());
      });
    }
  }
});

// Notification click listener
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/?source=pwa&tab=notifications');
      }
    })
  );
});
