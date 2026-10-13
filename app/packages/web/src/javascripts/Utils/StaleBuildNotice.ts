import { addToast, toastStore, ToastType } from '@standardnotes/toast'
import { reloadPage } from '@/Components/ComponentErrorBoundary/reloadPage'

/**
 * A code-split chunk that fails to load almost always means the server now
 * holds a different build than the one this tab started with: the entry
 * bundle asks for chunk files by the names IT was built with, and a redeploy
 * replaced them. Before the deployment fix that came with this module, the tab
 * could instead be handed the NEW build's chunk under the old name and fail
 * deep inside webpack ("e[r] is undefined"); nginx now answers a missing chunk
 * with 404 and the chunk names carry a content hash, so the failure arrives as
 * webpack's ChunkLoadError, which is what this recognises.
 *
 * What it does about it: one persistent toast with a Reload button. It never
 * reloads by itself. Reloading is a user action, and a user-initiated reload
 * runs the app's beforeunload guard (useUnsavedChangesWarning), which flushes
 * a pending editor save and asks before leaving if anything is still unsaved.
 */

export const STALE_BUILD_TITLE = 'This tab is running an older version of the app'
export const STALE_BUILD_MESSAGE =
  'Part of the app could not load because the server has been updated. Reload to get the current version. Nothing reloads by itself, and if anything is not saved yet you will be asked first.'
export const OFFLINE_CHUNK_TITLE = 'Part of the app could not load'
export const OFFLINE_CHUNK_MESSAGE =
  'You appear to be offline and this part of the app was not saved for offline use. Reload once you are back online.'

/**
 * Is `error` a failure to FETCH a code-split chunk (as opposed to one that
 * arrived and then threw)?
 *
 * - webpack's JSONP loader rejects with `name === 'ChunkLoadError'` and the
 *   message "Loading chunk <id> failed.";
 * - mini-css-extract-plugin rejects a lazy stylesheet with
 *   `code === 'CSS_CHUNK_LOAD_FAILED'` and "Loading CSS chunk <id> failed.";
 * - a native `import()` (workers, a module webpack did not bundle) rejects
 *   with "error loading dynamically imported module" (Gecko) or "Failed to
 *   fetch dynamically imported module" (Blink).
 */
export function isChunkLoadFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name === 'ChunkLoadError' || candidate.code === 'CSS_CHUNK_LOAD_FAILED') {
    return true
  }
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return /Loading (CSS )?chunk [\w-]+ failed/i.test(message) || /dynamically imported module/i.test(message)
}

let liveToastId: string | undefined

/** Is the notice on screen now? A dismissed notice may be shown again. */
function isNoticeShowing(): boolean {
  if (liveToastId === undefined) {
    return false
  }
  try {
    return toastStore.get().some((toast) => toast.id === liveToastId && !toast.dismissed)
  } catch {
    return false
  }
}

export type StaleBuildNoticeEnvironment = {
  isOnline?: () => boolean
  reload?: () => void
}

const browserIsOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false

/** Show the notice unless it is already on screen. */
export function announceStaleBuild(environment: StaleBuildNoticeEnvironment = {}): void {
  if (isNoticeShowing()) {
    return
  }
  const online = (environment.isOnline ?? browserIsOnline)()
  const reload = environment.reload ?? (() => reloadPage())
  liveToastId = addToast({
    type: ToastType.Error,
    title: online ? STALE_BUILD_TITLE : OFFLINE_CHUNK_TITLE,
    message: online ? STALE_BUILD_MESSAGE : OFFLINE_CHUNK_MESSAGE,
    actions: [{ label: 'Reload', handler: () => reload() }],
    autoClose: false,
  })
}

/** Announce if `error` is a chunk-load failure. Returns whether it was one. */
export function reportIfStaleBuild(error: unknown, environment: StaleBuildNoticeEnvironment = {}): boolean {
  if (!isChunkLoadFailure(error)) {
    return false
  }
  announceStaleBuild(environment)
  return true
}

/**
 * Catch the chunk failures nothing else handles: a dynamic `import()` outside
 * React.lazy whose rejection nobody awaited. Failures inside lazy components
 * are reported by lazyWithRetry and ComponentErrorBoundary instead. Neither
 * listener prevents the browser's default reporting.
 */
export function installStaleBuildNotice(
  target: Pick<Window, 'addEventListener'> | undefined = typeof window === 'undefined' ? undefined : window,
  environment: StaleBuildNoticeEnvironment = {},
): void {
  if (!target) {
    return
  }
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    reportIfStaleBuild(event.reason, environment)
  })
  target.addEventListener('error', (event: ErrorEvent) => {
    reportIfStaleBuild(event.error, environment)
  })
}

/** Test seam: forget the toast this module showed. */
export function resetStaleBuildNoticeForTests(): void {
  liveToastId = undefined
}
