// Таросвіт service worker: app shell works offline; readings always go to the network.
const VERSION = "tarosvit-v0.1.2";
const SHELL = ["/", "/index.html", "/app.css", "/app.js", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  // Only the app's own files and fonts. Supabase (account data) and /api/ always go straight to the network.
  if ((!sameOrigin && !isFont) || (sameOrigin && url.pathname.startsWith("/api/"))) return;

  // App files: network first so updates arrive at once, cache as the offline fallback
  if (sameOrigin) {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req.mode === "navigate" ? "/" : req, copy)); }
        return r;
      }).catch(() => caches.match(req.mode === "navigate" ? "/" : req))
    );
    return;
  }

  // Fonts: cache first, refresh in the background
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
