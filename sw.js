const CACHE = "discipline-diary-v227";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png",
  "./fonts/geist-400.woff2", "./fonts/geist-500.woff2", "./fonts/geist-600.woff2", "./fonts/geist-700.woff2", "./fonts/geist-800.woff2"];
// Firebase's own code, loaded from Google's CDN. The URLs include the
// version number, so a cached copy never goes stale — caching it lets the
// app open (and show an "offline" note) with no connection.
const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/";
// Saved at install time too, so the first offline open after an update
// still works (the old version's copy is deleted when the new one takes
// over). Keep the version in step with the imports at the top of app.js.
const FIREBASE_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => `${FIREBASE_CDN}10.12.2/${f}`);

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })))
      // Best effort: a failed Firebase download mustn't stop the install.
      .then(() => Promise.all(FIREBASE_FILES.map((url) => fetch(url).then((res) => (res.ok ? c.put(url, res) : null)).catch(() => null)))))
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
  if (!sameOrigin && !url.startsWith(FIREBASE_CDN)) return; // Firestore and sign-in: network only

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
