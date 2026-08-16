const CACHE_NAME = "joyfit24-9th-event-v16";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/mark-192.png",
  "./icons/mark-512.png",
  "./icons/mark-512-maskable.png",
  "./icons/mark-180.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(url => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.includes("script.google")) return;
  if (url.hostname.includes("googleapis") || url.hostname.includes("gstatic")) return;

  const isNavigate = request.mode === "navigate" || request.destination === "document";

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok && url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (isNavigate) {
        const page = await caches.match("./index.html") || await caches.match("./");
        if (page) return page;
      }
      return Response.error();
    }
  })());
});
