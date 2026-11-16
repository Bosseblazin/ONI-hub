/* Interplanetary Command service worker.
 * - Pages and static assets: network first, cached copy as fallback, so the app still opens (showing
 *   the last-known state from the device and a clear "home PC unreachable" banner) when offline.
 * - /api/*: never cached — live data and commands always go to the home PC. */
const CACHE = "ic-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/command", "/ops", "/alerts", "/settings", "/login", "/icon.svg"]).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && (e.request.mode === "navigate" || url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg")) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === "navigate" ? caches.match("/") : undefined)))
  );
});
