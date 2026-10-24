/* Service worker: lets the speedometer open with no data connection (GPS itself needs none). */
var CACHE = 'speedo-v1';
var SHELL = [
  './', './index.html', './speed-core.js', './manifest.webmanifest',
  './icon-180.png', './icon-192.png', './icon-512.png',
  './fonts/barlow-condensed-latin-500-normal.woff2',
  './fonts/barlow-condensed-latin-600-normal.woff2',
  './fonts/barlow-latin-500-normal.woff2',
  './fonts/barlow-latin-600-normal.woff2'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function timeout(ms) { return new Promise(function (_, reject) { setTimeout(reject, ms); }); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Fresh page when the network answers within 3 s, the cached copy otherwise.
    e.respondWith(
      Promise.race([fetch(req), timeout(3000)])
        .then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
          }
          return res;
        })
        .catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // Everything else: answer from the cache, refresh it in the background.
  var network = fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  });
  e.respondWith(caches.match(req).then(function (hit) { return hit || network; }));
  e.waitUntil(network.catch(function () {}));
});
