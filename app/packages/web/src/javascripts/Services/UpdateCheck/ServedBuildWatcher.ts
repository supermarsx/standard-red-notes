import { addToast, ToastType } from '@standardnotes/toast'
import { WebBuildRevision } from '@/Constants/BuildRevision'

const REVISION = /^[0-9a-f]{40}$/
let updateToastShown = false

export function showAppUpdateToast(refresh: () => void): void {
  if (updateToastShown) {
    return
  }
  updateToastShown = true
  addToast({
    type: ToastType.Regular,
    message: 'This tab is running an older build than the server serves. Refresh the app to update.',
    actions: [{ label: 'Refresh app', handler: refresh }],
    autoClose: false,
  })
}

/** Observe this deployment, independently of optional upstream release checks and admin diagnostics. */
export function watchServedBuild(
  revision = WebBuildRevision,
  fetchMarker: typeof fetch = (...args) => fetch(...args),
  notify: (refresh: () => void) => void = showAppUpdateToast,
  refresh: () => void = () => window.location.reload(),
): () => void {
  if (!REVISION.test(revision)) {
    return () => undefined
  }
  let stopped = false
  let checking = false
  let notified = false
  let controller: AbortController | undefined
  const check = async () => {
    if (stopped || checking || notified || document.visibilityState === 'hidden') {
      return
    }
    checking = true
    controller = new AbortController()
    const timeout = setTimeout(() => controller?.abort(), 10_000)
    try {
      const response = await fetchMarker('/.well-known/srn-deployment.json', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) {
        return
      }
      const marker: unknown = await response.json()
      const served = marker && typeof marker === 'object' ? (marker as { revision?: unknown }).revision : undefined
      if (!stopped && typeof served === 'string' && REVISION.test(served) && served !== revision) {
        notified = true
        notify(refresh)
      }
    } catch {
      /* Offline and failed probes do not mean a newer deployment exists. */
    } finally {
      clearTimeout(timeout)
      checking = false
      controller = undefined
    }
  }
  const wake = () => void check()
  const timer = setInterval(wake, 60_000)
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  window.addEventListener('focus', wake)
  void check()
  return () => {
    stopped = true
    clearInterval(timer)
    controller?.abort()
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
    window.removeEventListener('focus', wake)
  }
}
