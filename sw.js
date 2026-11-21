/* FOMO Desk service worker.
   Static shell: network-first, then cache.
   Relay/data requests (cache-busted or Supabase storage): network only, not stored.
*/
const SHELL = "desk-shell-v16";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./app.css?v=16",
  "./app.js?v=16",
  "./chart.js?v=16",
  "./relay_base.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) { return cache.addAll(SHELL_URLS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isRelayRequest(url) {
  if (url.searchParams.has("cb")) return true;
  if (url.pathname.indexOf("/storage/v1/object/") !== -1) return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isRelayRequest(url)) {
    event.respondWith(fetch(req));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(SHELL).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match("./index.html");
      });
    })
  );
});
