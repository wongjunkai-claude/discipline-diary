// WordPasture service worker: lets the app open and read offline, and keeps the Bible text close at hand.
// The app itself (index.html) is always fetched fresh when there's a connection, so updates arrive straight away;
// the saved copy is only used when offline. "Update now" in the app clears everything here and starts again.
const VERSION = "wp-2.18.4";
const SHELL = ["./", "index.html", "manifest.webmanifest", "firebase-config.js", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  // Firebase's own code (the version is in the address, so a saved copy never goes stale); keep in step with FB_VERSION in index.html
  ...["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => "https://www.gstatic.com/firebasejs/10.12.2/" + f)];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const fresh = async req => {   // network first, saved copy when offline
  const c = await caches.open(VERSION);
  try { const r = await fetch(req); if (r && r.ok) c.put(req, r.clone()); return r; }
  catch (e) { return (await c.match(req, { ignoreSearch: true })) || (await c.match("index.html")) || Response.error(); }
};
const kept = async req => {    // saved copy first (Bible books, questions, icons, libraries never change at the same address)
  const c = await caches.open(VERSION), hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req); if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r;
};

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const u = new URL(req.url);
  // the database, sign-in and update checks always go straight to the network
  if (/googleapis\.com|firebaseio|identitytoolkit|securetoken/.test(u.host)) return;
  if (u.origin === location.origin && /version\.json$/.test(u.pathname)) return;
  if (u.origin === location.origin && u.pathname.startsWith("/__/")) return;   // Firebase's own sign-in pages
  if (req.mode === "navigate" || (u.origin === location.origin && /(\/|\.html|firebase-config\.js|manifest\.webmanifest)$/.test(u.pathname))) { e.respondWith(fresh(req)); return; }
  if (u.origin === location.origin && /\/(en|zh|zq|questions|icons)\//.test(u.pathname)) { e.respondWith(kept(req)); return; }
  if (/cdnjs\.cloudflare\.com|gstatic\.com|fonts\.(googleapis|gstatic)\.com/.test(u.host)) { e.respondWith(kept(req)); return; }
});
