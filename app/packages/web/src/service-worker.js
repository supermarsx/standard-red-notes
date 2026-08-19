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
const SANDBOX_PATH = '/sandbox.html'
const DEPLOYMENT_MARKER_PATH = '/.well-known/srn-deployment.json'

// Minimal set of files that make up the bootable shell. Everything else
// (components, editors, fonts, vendor libsodium, etc.) is cached on first use
// by the runtime fetch handler below.
const CORE_SHELL = ['/', '/index.html', SANDBOX_PATH, '/app.js', '/app.css', '/manifest.webmanifest']

function unavailableSandboxResponse() {
  return new Response('The isolated code sandbox is unavailable while offline. Reconnect and run it again.', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Use `reload` so install doesn't pick up an already-stale HTTP cache
        // entry, and tolerate individual misses (e.g. a 404 on one optional
        // file must not abort the whole install).
        Promise.allSettled(CORE_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))),
      )
      // Take over without waiting for every tab to close. A previously cached
      // shell — a proxy error page, or simply the PREVIOUS release's index.html —
      // stays servable for as long as the old worker keeps control, and serving
      // it under the new deployment's CSP trips the inline-script hash pin (the
      // pin is generated per deploy from the real index.html, so an older but
      // perfectly valid shell mismatches it too, with a different hash each
      // release). Activating immediately runs the purge below, which is the only
      // thing that evicts an already-poisoned or simply outdated cache.
      // `activate` then claims clients and registerServiceWorker.ts reloads once.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('srn-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
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
  // Deployment acceptance must always observe the current nginx/image marker,
  // never a stale-while-revalidate response retained from the prior release.
  if (url.pathname === DEPLOYMENT_MARKER_PATH) {
    return
  }

  // HTML navigations: network-first so users get the freshest shell when
  // online, falling back to the cached shell (then index.html) when offline.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only a real app shell may enter the cache. A reverse proxy that is
          // between releases answers navigations with its own 502/503/504 HTML;
          // storing that would pin an error page as the offline shell (served
          // afterwards under the app CSP, whose inline-script hash pins the REAL
          // index.html — so the error page's own inline script is then blocked).
          // Same gate the asset handlers below already apply.
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => {
          // Scoped to THIS build's cache on purpose. `caches.match` searches every
          // cache in the origin, so a leftover `srn-shell-<older build>` entry that
          // the activate purge failed to delete could otherwise be served as the
          // shell for this deployment — the stale-shell CSP mismatch again.
          const cache = await caches.open(CACHE_NAME)
          const cached = await cache.match(request)
          if (cached) {
            return cached
          }
          // Never substitute the application shell for the executable runner.
          // It has a different CSP and no sandbox message contract. Returning
          // inert text keeps an offline cache miss explicit and fail-closed.
          if (url.pathname === SANDBOX_PATH) {
            return unavailableSandboxResponse()
          }
          return cache.match('/index.html')
        }),
    )
    return
  }

  // The app bundle (`/app.js`, `/app.css`, AND the lazy chunks `<id>.app.js`) is
  // rebuilt on EVERY deploy but the chunk filenames are NOT content-hashed, so a
  // chunk keeps its name while its content changes. Serve all of them
  // network-first like the HTML: otherwise a fresh, network-first `app.js`
  // references chunks whose STALE cache-first copies the SW returns —
  // "Loading chunk N failed" for lazy components (e.g. the Super editor), or a
  // blank page for the entry. Falls back to the cached copy when offline.
  if (url.pathname.endsWith('app.js') || url.pathname.endsWith('app.css')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(request))),
    )
    return
  }

  // Other same-origin static assets (fonts/images/components/hashed chunks):
  // cache-first, with a background refresh (stale-while-revalidate) so updated
  // files are picked up on the next load without blocking the current one.
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
