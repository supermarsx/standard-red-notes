/* eslint-disable */
/*
 * Standard Red Notes — app-shell service worker.
 *
 * GOAL: make the APP ITSELF load when the browser is offline by caching the
 * static shell (HTML/JS/CSS/fonts/icons/components). Note DATA lives in
 * IndexedDB and syncs separately — this SW deliberately does NOT touch any
 * API / sync / cross-origin traffic.
 *
 * This is a plain hand-authored SW (no Workbox). It is copied verbatim to the
 * server root (`/service-worker.js`) by CopyWebpackPlugin, so its scope is `/`.
 *
 * The `__SW_VERSION__` token below is replaced at build time (by the
 * CopyWebpackPlugin transform in web.webpack.config.js) with the web package
 * version, so every deploy produces a fresh cache name; the old cache is
 * purged on `activate`, preventing users from being stuck on a stale shell.
 */

const SW_VERSION = '__SW_VERSION__'
const CACHE_NAME = 'srn-shell-' + SW_VERSION

// Minimal set of files that make up the bootable shell. Everything else
// (components, editors, fonts, vendor libsodium, etc.) is cached on first use
// by the runtime fetch handler below.
const CORE_SHELL = ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Use `reload` so install doesn't pick up an already-stale HTTP cache
        // entry, and tolerate individual misses (e.g. a 404 on one optional
        // file must not abort the whole install).
        Promise.allSettled(
          CORE_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
        ),
      ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('srn-shell-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

// Allow the page to tell a freshly-installed-but-waiting SW to take over now,
// powering the "new version available — reload" update flow on the client.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting()
  }
})

function isApiRequest(url) {
  // Versioned sync-server endpoints and any auth/subscription/websocket paths.
  return (
    /\/v\d+\//.test(url.pathname) ||
    url.pathname.startsWith('/v1') ||
    url.pathname.startsWith('/v2') ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/sockets') ||
    url.pathname.startsWith('/subscription')
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Only ever touch GET. POST/PUT/etc. (all sync writes) pass straight through.
  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)

  // CRITICAL EXCLUSIONS — never intercept these, or sync/E2E breaks:
  //  - cross-origin (sync server, files host, websockets, any CDN)
  //  - non-http(s) schemes (chrome-extension:, data:, blob:)
  //  - same-origin API/sync endpoints
  if (url.origin !== self.location.origin) {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return
  }
  if (isApiRequest(url)) {
    return
  }

  // HTML navigations: network-first so users get the freshest shell when
  // online, falling back to the cached shell (then index.html) when offline.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          return response
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/index.html')),
        ),
    )
    return
  }

  // Same-origin static assets (JS/CSS/fonts/images/components): cache-first,
  // with a background refresh (stale-while-revalidate) so updated files are
  // picked up on the next load without blocking the current one.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
              cache.put(request, response.clone())
            }
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    ),
  )
})
