// Caching is intentionally omitted for now — deferred to a later hardening pass.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
