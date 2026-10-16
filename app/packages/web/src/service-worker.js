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
// (components, editors, fonts, etc.) is cached on first use by the runtime
// fetch handler below. The hashed libsodium WASM asset is cached there on first
// use, alongside its JavaScript wrapper.
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
      // `activate` then claims clients; the page offers a Refresh app action.
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

// The same request, but one the browser's HTTP cache must REVALIDATE before
// answering (a conditional request; a 304 still costs no body). A plain
// `fetch(request)` lets the HTTP cache answer without touching the network, and
// copies stored before nginx sent `Cache-Control: no-cache` are heuristically
// fresh: that is how a page ran the new app.js beside a previous build's lazy
// chunks after a redeploy. Re-initialising a navigation request turns its mode
// into "same-origin" (Fetch spec) and keeps its redirect mode; an engine that
// still refuses to re-initialise one gets the plain request rather than an
// exception, which is no worse than before.
function revalidating(request) {
  try {
    return new Request(request, { cache: 'no-cache' })
  } catch (error) {
    return request
  }
}

// Cache storage is an optional optimization. A quota/access failure must not
// reject an otherwise valid online response or create unhandled rejections.
function cacheResponse(request, response, event) {
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return
  }
  const copy = response.clone()
  const write = caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => undefined)
  event.waitUntil?.(write)
}

// Content-hashed WASM is immutable. Each crypto worker has its own runtime,
// but simultaneous loads should share the bytes rather than stampede the server.
const immutableWasmRequests = new Map()
function immutableWasmResponse(request, event) {
  const key = request.url
  let pending = immutableWasmRequests.get(key)
  if (!pending) {
    let cacheWrite = Promise.resolve()
    pending = (async () => {
      let cache
      try {
        cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(request)
        if (cached) {
          return cached
        }
      } catch {
        // Cache/quota failures must not prevent an online crypto initialization.
      }
      const response = await fetch(request)
      if (cache && response.status === 200 && response.type === 'basic') {
        cacheWrite = cache.put(request, response.clone()).catch(() => undefined)
      }
      return response
    })()
    immutableWasmRequests.set(key, pending)
    const complete = pending
      .then(() => cacheWrite)
      .catch(() => undefined)
      .finally(() => {
        if (immutableWasmRequests.get(key) === pending) {
          immutableWasmRequests.delete(key)
        }
      })
    // Keep the cache write alive without holding up delivery of the WASM bytes.
    event.waitUntil(complete)
  }
  // Response bodies are streams; every worker must receive its own readable copy.
  return pending.then((response) => response.clone())
}

function isApiRequest(url) {
  // Versioned sync-server endpoints and any auth/subscription/websocket paths.
  return (
    /^\/(?:health|healthcheck)(?:\/|$)/.test(url.pathname) ||
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

  if (/\.[0-9a-f]{16,64}\.wasm$/i.test(url.pathname)) {
    event.respondWith(immutableWasmResponse(request, event))
    return
  }

  // HTML navigations: network-first so users get the freshest shell when
  // online, falling back to the cached shell (then index.html) when offline.
  // Revalidated, so "network-first" cannot be answered by a stale HTTP-cache copy.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(revalidating(request))
        .then((response) => {
          // Only a real app shell may enter the cache. A reverse proxy that is
          // between releases answers navigations with its own 502/503/504 HTML;
          // storing that would pin an error page as the offline shell (served
          // afterwards under the app CSP, whose inline-script hash pins the REAL
          // index.html — so the error page's own inline script is then blocked).
          // Same gate the asset handlers below already apply.
          cacheResponse(request, response, event)
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

  // The app bundle (`/app.js`, `/app.css`, AND the lazy chunks
  // `<id>.<contenthash>.app.js` / `.app.css`) is rebuilt on EVERY deploy. The
  // entry keeps its name while its content changes, and chunks were unhashed
  // `<id>.app.js` until recently - a browser may still hold those. Serve all of
  // them network-first like the HTML: otherwise a fresh, network-first `app.js`
  // references chunks whose STALE cache-first copies the SW returns -
  // "Loading chunk N failed" for lazy components (e.g. the Super editor), or a
  // blank page for the entry. Falls back to the cached copy when offline.
  // Revalidated for the same reason as navigations: the HTTP cache may hold the
  // previous build's copy under the same name. (A hashed chunk revalidates
  // cheaply: nginx marks it immutable, and a 304 carries no body.)
  if (url.pathname.endsWith('app.js') || url.pathname.endsWith('app.css')) {
    event.respondWith(
      fetch(revalidating(request))
        .then((response) => {
          cacheResponse(request, response, event)
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
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(request))
      .catch(() => undefined)
      .then((cached) => {
        const network = fetch(request)
          .then((response) => {
            cacheResponse(request, response, event)
            return response
          })
          .catch((error) => {
            if (cached) {
              return cached
            }
            throw error
          })
        if (cached) {
          event.waitUntil?.(network.then(() => undefined).catch(() => undefined))
        }
        return cached || network
      }),
  )
})
