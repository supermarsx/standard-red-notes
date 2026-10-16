import { addToast, ToastType } from '@standardnotes/toast'

let lastNoticeAt = -Infinity

/** Multiple room/control failures in a burst produce one transient notice. */
export function showCollaborationThrottle(scope: 'collaboration' | 'realtime' | 'request' = 'collaboration'): void {
  if (Date.now() - lastNoticeAt < 30_000) {
    return
  }
  lastNoticeAt = Date.now()
  try {
    addToast({
      type: ToastType.Regular,
      message:
        scope === 'request'
          ? 'The server temporarily rate-limited this request. Wait a moment and retry.'
          : scope === 'realtime'
            ? 'Realtime sync is temporarily throttled. Retrying automatically; keep the app open.'
            : 'Live collaboration is temporarily throttled. Retrying automatically; keep this note open.',
    })
  } catch {
    // A notification must never interrupt room recovery.
  }
}
