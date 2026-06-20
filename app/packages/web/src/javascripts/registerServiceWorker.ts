import { addToast, ToastType } from '@standardnotes/toast'

/**
 * Registers the app-shell service worker (see /service-worker.js) so the app
 * loads when offline. Data still lives in IndexedDB and syncs separately — the
 * SW only caches same-origin static assets + the app HTML, never API/sync.
 *
 * Update flow: when a new SW finishes installing while an old one controls the
 * page, we surface a non-blocking "new version available" toast. Reloading
 * tells the waiting SW to take over (skipWaiting), and a single controller
 * change triggers one reload onto the fresh shell. This avoids trapping users
 * on a stale cached version after a deploy.
 */
export function registerServiceWorker(): void {
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
        // eslint-disable-next-line no-console
        console.error('Service worker registration failed:', error)
      })

    // When the controlling SW changes after an update (skipWaiting), reload
    // exactly once so the page runs against the new shell. Skip this on the
    // first-visit claim, which is not an update.
    let hasReloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hasReloaded || !hadControllerAtLoad) {
        return
      }
      hasReloaded = true
      window.location.reload()
    })
  })
}

function showUpdateToast(waitingWorker: ServiceWorker): void {
  addToast({
    type: ToastType.Regular,
    message: 'A new version of Standard Red Notes is available.',
    actions: [
      {
        label: 'Reload',
        handler: () => {
          waitingWorker.postMessage('SKIP_WAITING')
        },
      },
    ],
    autoClose: false,
  })
}
