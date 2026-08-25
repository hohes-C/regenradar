// Service Worker. App-Shell cache-first, Bright Sky strikt network-only.
// Bei jeder Aenderung an der Shell CACHE_VERSION erhoehen.

const CACHE_VERSION = "regenradar-v13";

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "src/config.js",
  "src/api.js",
  "src/alerts.js",
  "src/nowcast.js",
  "src/text.js",
  "src/places.js",
  "src/ui.js",
  "src/main.js",
  "src/debug.js",
  "icons/icon.svg",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  // Beim Precache frisch vom Server laden (cache:"reload"), sonst kann der
  // HTTP-Cache eine veraltete Datei in die neue Version schreiben.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Bright Sky (bzw. spaeter das eigene Backend) nie cachen, kein Fallback.
  if (url.hostname.endsWith("brightsky.dev")) return;

  // Nur die eigene App-Shell bedienen.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Erfolgreiche Shell-Antworten in die aktuelle Version legen.
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline und Navigation: die App-Shell liefern.
          if (req.mode === "navigate") return caches.match("index.html");
          return Response.error();
        });
    })
  );
});
