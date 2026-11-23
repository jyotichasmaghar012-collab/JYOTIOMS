/*
 * Service worker for the Jyoti Chasmaghar staff/admin OMS PWA.
 *
 * This is a STAFF app dealing with live business data (stock counts, order
 * statuses, payments) - so it deliberately does NOT cache HTML pages or API
 * responses. Showing a staff member a stale "in stock" count or a stale
 * order list could cause real mistakes (double-selling the same frame,
 * missing a pending order). The only thing this worker caches is the static
 * app shell (CSS/JS/icons) so the app opens fast and installably; every
 * actual data page always goes to the network, falling back to a simple
 * "you're offline" page only when the network request genuinely fails.
 */
const CACHE_VERSION = "oms-shell-v1";
const SHELL_ASSETS = [
  "/static/css/style.css",
  "/static/js/app.js",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-512.png",
  "/static/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST/etc (form saves, order creation, ...)

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch third-party requests

  // Full-page navigations (clicking a link, typing a URL, opening the
  // installed app): always go to the network first so staff always see
  // live data. Only fall back to the offline page if the network is
  // genuinely unreachable.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/static/offline.html"))
    );
    return;
  }

  // Static app-shell assets (CSS/JS/icons): cache-first for speed, but
  // always refresh the cache in the background so the next load picks up
  // any deployed change.
  if (SHELL_ASSETS.some((a) => url.pathname === a)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((resp) => {
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, resp.clone()));
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Everything else (JSON endpoints, uploaded images, other pages' assets)
  // - just pass through to the network untouched. No offline caching of
  // business data.
});
