// Service worker — offline app shell (v0.24.0).
//
// Goal: a phone with no signal can still OPEN the trip it has opened before.
// The page and the trip itself (kept in localStorage by the bootstrap) plus the
// last lists snapshot (kept by the app) do the rest.
//
// Rules, deliberately small:
// - /api/* is NEVER cached here. Family data is per-session and needs a token;
//   the app keeps its own signed-in snapshot and clears it at sign-out.
// - The page ('/', '/index.html' only, HTML only) is network-first with a 4 s
//   cap: online you get the version the server has, so a deploy is picked up
//   on the next open. Offline, or on a signal too weak to answer in 4 s, you
//   get the last good copy.
// - Vendored files (React, Leaflet, icons, manifest) are stale-while-
//   revalidate: served from the cache at once, refreshed in the background, so
//   a changed file is picked up on the following open.
// - Everything else (admin page, fonts, map tiles, other origins) is left to
//   the network untouched.
const SHELL = 'trip-shell-v2';
const PAGE = '/';
const VENDOR = ['/react.production.min.js', '/react-dom.production.min.js', '/leaflet.js', '/leaflet.css',
  '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll([PAGE].concat(VENDOR))).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.indexOf('trip-shell-') === 0 && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  // Only the app page itself is kept — never admin.html or any other page.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // Network first, but a weak signal must not hang the open: after 4 s the
    // saved copy answers while the network keeps trying (and still refreshes
    // the saved copy if it gets through).
    const net = fetch(req);
    // Registered now, while the event is live: the saved copy is refreshed
    // even when the 4 s cap has already answered from it.
    e.waitUntil(net.then(res => {
      const html = res && res.ok && (res.headers.get('content-type') || '').indexOf('text/html') === 0;
      if (!html) return;
      const copy = res.clone(); // now, before the page starts reading the body
      return caches.open(SHELL).then(c => c.put(PAGE, copy));
    }).catch(() => {}));
    const saved = () => caches.match(PAGE);
    e.respondWith(new Promise(resolve => {
      let done = false;
      const finish = r => { if (!done && r) { done = true; resolve(r); } };
      const timer = setTimeout(() => saved().then(finish), 4000);
      net.then(r => { clearTimeout(timer); finish(r); },
        () => { clearTimeout(timer); saved().then(hit => { finish(hit || Response.error()); }); });
    }));
    return;
  }

  if (VENDOR.indexOf(url.pathname) >= 0) {
    e.respondWith(caches.open(SHELL).then(c => c.match(url.pathname).then(hit => {
      const refresh = fetch(req).then(res => {
        if (!res || !res.ok) return res;
        return c.put(url.pathname, res.clone()).then(() => res, () => res);
      });
      if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; } // background refresh, kept alive
      return refresh.catch(() => Response.error());
    })));
  }
});
