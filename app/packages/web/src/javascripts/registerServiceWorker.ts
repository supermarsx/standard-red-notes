import { showAppUpdateToast, watchServedBuild } from './Services/UpdateCheck/ServedBuildWatcher'

/**
 * Registers the app-shell service worker (see /service-worker.js) so the app
 * loads when offline. Data still lives in IndexedDB and syncs separately — the
 * SW only caches same-origin static assets + the app HTML, never API/sync.
 *
 * Update flow: when a new SW finishes installing while an old one controls the
 * page, we surface a non-blocking "new version available" toast. Reloading
 * fetches the fresh shell. A controller change also announces an update, but
 * never reloads an editor without the user choosing Refresh app.
 */
export function registerServiceWorker(): void {
  watchServedBuild()
  if (!('serviceWorker' in navigator)) {
    return
  }

  // Service workers require a secure context. localhost is treated as secure,
  // but http:// on any other host is not — skip there to avoid a console error.
  if (!window.isSecureContext) {
    return
  }

  // Whether a SW already controls this page at load. On the very first visit
  // there is no controller, so `clients.claim()` in the SW's activate handler
  // fires a `controllerchange` we must NOT treat as an update-reload.
  const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller)

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { scope: '/' })
      .then((registration) => {
        // A new SW found while a controller already exists => an update.
        const promptIfWaiting = (worker: ServiceWorker | null) => {
          if (!worker) {
            return
          }
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(worker)
            }
          })
        }

        // Already waiting at registration time (installed before this load).
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdateToast(registration.waiting)
        }

        registration.addEventListener('updatefound', () => {
          promptIfWaiting(registration.installing)
        })
      })
      .catch((error) => {
        console.error('Service worker registration failed:', error)
      })

    // Activation may happen automatically to evict an outdated shell cache.
    // Keep the running editor intact until the user chooses to refresh.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadControllerAtLoad) {
        return
      }
      showAppUpdateToast(() => window.location.reload())
    })
  })
}

function showUpdateToast(waitingWorker: ServiceWorker): void {
  showAppUpdateToast(() => {
    // The navigation fetches the network-first shell even if activation lags.
    waitingWorker.postMessage('SKIP_WAITING')
    window.location.reload()
  })
}
