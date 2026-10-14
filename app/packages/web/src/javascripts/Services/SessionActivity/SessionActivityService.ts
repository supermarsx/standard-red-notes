import { ApplicationEvent } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { collaborationDeviceId } from '@/Components/SuperEditor/Collaboration/CollaborationDeviceIdentity'

export const SESSION_ACTIVITY_INTERVAL_MS = 30_000

/** Visible browser profile activity only. Its opaque id is never an auth credential. */
export class SessionActivityService {
  private disposed = false
  private pending = false
  private timer: ReturnType<typeof setInterval>
  private disposeObserver: () => void

  constructor(private application: WebApplication) {
    this.disposeObserver = application.addEventObserver(async (event) => {
      if (event === ApplicationEvent.SignedIn || event === ApplicationEvent.Launched) {
        void this.record()
      }
    })
    this.timer = setInterval(() => void this.record(), SESSION_ACTIVITY_INTERVAL_MS)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('online', this.onVisibility)
    void this.record()
  }

  private onVisibility = () => {
    void this.record()
  }

  async record(): Promise<void> {
    if (
      this.disposed ||
      this.pending ||
      document.visibilityState === 'hidden' ||
      !navigator.onLine ||
      this.application.sessions.isSignedOut()
    ) {
      return
    }
    const deviceId = collaborationDeviceId()
    if (!deviceId) {
      return
    }
    this.pending = true
    try {
      await this.application.legacyApi.recordSessionActivity(deviceId)
    } catch {
      // Presence failures never block editing, trigger sync or expose credentials.
    } finally {
      this.pending = false
    }
  }

  deinit(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.disposeObserver()
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('online', this.onVisibility)
  }
}
