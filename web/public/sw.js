// App-shell service worker: network-first for pages, cache-first for hashed build assets.
// API, media, and public pages are never cached here.
const CACHE = "pp-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/m/") || url.pathname.startsWith("/s/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((r) => { caches.open(CACHE).then((c) => c.put("/", r.clone())); return r; }).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request).then((r) => { caches.open(CACHE).then((c) => c.put(event.request, r.clone())); return r; })));
  }
});
