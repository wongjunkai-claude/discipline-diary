const CACHE = "discipline-diary-v182";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];
// Firebase's own code, loaded from Google's CDN. The URLs include the
// version number, so a cached copy never goes stale — caching it lets the
// app open (and show an "offline" note) with no connection.
const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // Sheet sync posts etc. go straight to the network

  // Page loads: always try the network first (so a new release shows up),
  // and fall back to the cached copy of the app when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  const url = req.url;
  const sameOrigin = url.startsWith(self.location.origin);
  if (!sameOrigin && !url.startsWith(FIREBASE_CDN)) return; // Firestore, sign-in, fonts: network only

  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && url.startsWith(FIREBASE_CDN)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
