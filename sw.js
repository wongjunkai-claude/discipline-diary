const CACHE = "discipline-diary-v4";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// App shell cached for install/offline launch. Firestore reads/writes still
// need a live network connection — this only caches the static files.
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") return; // let network handle live navigation
  e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});
