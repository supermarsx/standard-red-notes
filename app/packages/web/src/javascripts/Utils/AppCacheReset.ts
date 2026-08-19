/**
 * Standard Red Notes: on-demand eviction of the app-shell caches.
 *
 * *** SAFETY BOUNDARY — the whole point of this module ***
 *
 * This app is offline-capable and end-to-end encrypted. Notes, files, keys, the
 * session and PENDING UNSYNCED WRITES all live in IndexedDB / localStorage:
 *
 *   - IndexedDB `<identifier>`                        items (notes/tags/etc.)
 *   - IndexedDB `<identifier>-local-files`            downloaded file payloads
 *   - IndexedDB (KeychainEncryption)                  wrapped root key material
 *   - IndexedDB `standardnotes-sync-transport-v1`     the sync OUTBOX — every
 *                                                     not-yet-acked write
 *   - localStorage (WebOrDesktopDevice raw storage)   session + storage values
 *
 * None of that is Cache Storage, so a reload cannot lose it. The ONLY Cache
 * Storage writer in this codebase is /service-worker.js, which uses exactly one
 * cache per build, named `srn-shell-<version>-<buildId>`.
 *
 * Therefore this module:
 *   - deletes ONLY Cache Storage entries whose name starts with `srn-shell-`
 *     (an unprefixed `caches.delete()` sweep would also destroy caches this app
 *     does not own and cannot reason about), and
 *   - never references indexedDB / localStorage / sessionStorage at all. That
 *     absence is asserted by a test; keep it that way.
 */

/** Cache-name prefix owned by /service-worker.js. Nothing else may be deleted. */
export const SHELL_CACHE_PREFIX = 'srn-shell-'

export type AppCacheResetResult = {
  /** Shell caches actually removed. */
  deletedCaches: string[]
  /** Caches deliberately left alone because they are not ours to delete. */
  preservedCaches: string[]
  /** Service worker registrations unregistered. */
  unregisteredWorkers: number
}

export type AppCacheResetEnvironment = {
  caches?: CacheStorage
  serviceWorker?: ServiceWorkerContainer
}

function resolveEnvironment(environment?: AppCacheResetEnvironment): AppCacheResetEnvironment {
  if (environment) {
    return environment
  }

  return {
    caches: typeof globalThis !== 'undefined' ? (globalThis as { caches?: CacheStorage }).caches : undefined,
    serviceWorker: typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  }
}

/**
 * Unregister every service worker registration in scope. Done BEFORE the cache
 * purge: the active worker keeps controlling this page until it unloads, so any
 * fetch it serves in the meantime could re-populate a cache we just emptied.
 * Unregistering first guarantees the post-reload document load is uncontrolled
 * and goes to the network.
 */
async function unregisterServiceWorkers(container: ServiceWorkerContainer | undefined): Promise<number> {
  if (!container || typeof container.getRegistrations !== 'function') {
    return 0
  }

  const registrations = await container.getRegistrations()
  const results = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)))

  return results.filter(Boolean).length
}

/**
 * Delete the shell caches and unregister the service worker. Does NOT reload —
 * callers decide that, so this stays testable and usable from the console.
 */
export async function clearApplicationShellCaches(
  environment?: AppCacheResetEnvironment,
): Promise<AppCacheResetResult> {
  const { caches: cacheStorage, serviceWorker } = resolveEnvironment(environment)

  const unregisteredWorkers = await unregisterServiceWorkers(serviceWorker)

  const result: AppCacheResetResult = {
    deletedCaches: [],
    preservedCaches: [],
    unregisteredWorkers,
  }

  if (!cacheStorage || typeof cacheStorage.keys !== 'function') {
    return result
  }

  const keys = await cacheStorage.keys()

  for (const key of keys) {
    if (!key.startsWith(SHELL_CACHE_PREFIX)) {
      // Not written by our service worker — we cannot know what it holds, so we
      // leave it. Being incomplete is recoverable; deleting someone else's data
      // is not.
      result.preservedCaches.push(key)
      continue
    }

    const deleted = await cacheStorage.delete(key).catch(() => false)
    if (deleted) {
      result.deletedCaches.push(key)
    }
  }

  return result
}

/**
 * Full "reload the app cleanly" action: purge shell caches, drop the service
 * worker, then hard-navigate.
 *
 * `location.reload()` (rather than a React re-render or a router navigation) is
 * what makes this a genuine reload: the document is torn down and re-fetched.
 * With the worker unregistered and its caches gone there is nothing left to
 * serve a stale shell; the only layer still in play is the browser's own HTTP
 * cache, which the server's no-cache headers on index.html already govern.
 * Deliberately mirrors the blank-screen recovery path in src/index.html.
 */
export async function reloadApplicationClearingCaches(
  environment?: AppCacheResetEnvironment,
  reload: () => void = () => window.location.reload(),
): Promise<AppCacheResetResult> {
  const result = await clearApplicationShellCaches(environment)
  reload()
  return result
}
