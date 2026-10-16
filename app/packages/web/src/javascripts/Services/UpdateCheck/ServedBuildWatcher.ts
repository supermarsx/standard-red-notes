import { addToast, ToastType } from '@standardnotes/toast'
import { WebBuildRevision } from '@/Constants/BuildRevision'
import type { WebApplication } from '@/Application/WebApplication'

const REVISION = /^[0-9a-f]{40}$/
let updateToastShown = false
const MIN_PROBE_INTERVAL_MS = 15_000

type ServedBuildApplication = Pick<
  WebApplication,
  'serverGetJsonRequest' | 'syncTransportStatus' | 'getHost' | 'sessions'
>

function servedRevision(marker: unknown): string | undefined {
  const revision = marker && typeof marker === 'object' ? (marker as { revision?: unknown }).revision : undefined
  return typeof revision === 'string' && REVISION.test(revision) ? revision : undefined
}

function canReadDeploymentThroughSocket(
  application: ServedBuildApplication | undefined,
): application is ServedBuildApplication {
  try {
    return Boolean(
      application?.sessions.getUser() &&
      application.syncTransportStatus?.state === 'READY' &&
      application.syncTransportStatus.operations.includes('API_RPC') &&
      new URL(application.getHost.execute().getValue()).origin === window.location.origin,
    )
  } catch {
    return false
  }
}

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
  resolveApplication: () => ServedBuildApplication | undefined = () =>
    window.mainApplicationGroup?.primaryApplication as WebApplication | undefined,
): () => void {
  if (!REVISION.test(revision)) {
    return () => undefined
  }
  let stopped = false
  let checking = false
  let notified = false
  let controller: AbortController | undefined
  let lastStarted = -Infinity
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  const check = async () => {
    if (stopped || checking || notified || document.visibilityState === 'hidden' || navigator.onLine === false) {
      return
    }
    const delay = MIN_PROBE_INTERVAL_MS - (Date.now() - lastStarted)
    if (delay > 0) {
      wakeTimer ??= setTimeout(() => {
        wakeTimer = undefined
        void check()
      }, delay)
      return
    }
    if (wakeTimer !== undefined) {
      clearTimeout(wakeTimer)
      wakeTimer = undefined
    }
    checking = true
    lastStarted = Date.now()
    controller = new AbortController()
    const timeout = setTimeout(() => controller?.abort(), 10_000)
    try {
      let served: string | undefined
      // The watcher starts before the application. Resolve it anew for each
      // probe, and only ask this deployment's already-negotiated socket lane.
      const application = resolveApplication()
      if (canReadDeploymentThroughSocket(application)) {
        try {
          const response = await application.serverGetJsonRequest<unknown>('/v1/deployment/web', controller.signal)
          if (response.ok) {
            served = servedRevision(response.data)
          }
        } catch {
          // Older backends and unavailable socket reads retain the public
          // same-origin marker path used before authentication/bootstrap.
        }
      }
      if (!served && !stopped && !controller.signal.aborted) {
        const response = await fetchMarker('/.well-known/srn-deployment.json', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (response.ok) {
          served = servedRevision(await response.json())
        }
      }
      if (!stopped && served && served !== revision) {
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
    clearTimeout(wakeTimer)
    controller?.abort()
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
    window.removeEventListener('focus', wake)
  }
}
