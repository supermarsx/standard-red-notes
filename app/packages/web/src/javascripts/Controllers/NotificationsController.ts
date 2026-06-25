import { ApplicationEvent } from '@standardnotes/snjs'
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'
import { AbstractViewController } from './Abstract/AbstractViewController'

export type NotificationLevel = 'info' | 'warning' | 'error'

export type NotificationAction = {
  label: string
  run: () => void
}

export type AppNotification = {
  /** Stable id for a given *condition* (e.g. 'no-account'), so dismissals stick. */
  id: string
  title: string
  message: string
  level: NotificationLevel
  action?: NotificationAction
  /** Whether the user may dismiss this notification with the X button. */
  dismissable?: boolean
}

/**
 * Standard Red Notes: centralizes the app's scattered alerts/warnings into one
 * observable list surfaced by the "Notifications" sidebar item.
 *
 * Sources aggregated:
 *  - "Data not backed up" — derived from the signed-out state (mirrors the
 *    inline {@link NoAccountWarningController} condition: signed out => not backed
 *    up to an account).
 *  - "Sign in needed" — the involuntary re-auth state (the account session became
 *    invalid and the user dismissed the re-login prompt), observed off
 *    `accountMenuController.reloginPromptDismissed` (same signal the footer's
 *    connection chip uses for `login-needed`).
 *  - "You're offline" — `navigator.onLine` reachability loss.
 *  - "Sync problem" — a persisting sync failure / out-of-sync state
 *    (ApplicationEvent.FailedSync / EnteredOutOfSync), plus rate limiting
 *    (ApplicationEvent.SyncTooManyRequests).
 *
 * Recomputation is event-driven (the same discrete ApplicationEvents the
 * connection hook listens to) — never a tight poll. `count` is a computed of the
 * non-dismissed notifications. Transient notifications can be dismissed; the
 * dismissed id is tracked in memory and the notification re-surfaces if the
 * condition later recurs (we clear a dismissal once its condition clears, so the
 * next occurrence shows again).
 */
export class NotificationsController extends AbstractViewController {
  notifications: AppNotification[] = []

  /** Ids the user has dismissed; cleared when the underlying condition clears. */
  private dismissedIds = new Set<string>()

  private syncFailing = false
  private syncRateLimited = false

  constructor(private application: WebApplication) {
    super(application.events)

    makeObservable(this, {
      notifications: observable,
      count: computed,
      dismiss: action,
    })

    this.disposers.push(
      this.application.addEventObserver(async (event) => {
        switch (event) {
          case ApplicationEvent.FailedSync:
          case ApplicationEvent.EnteredOutOfSync:
            this.syncFailing = true
            this.recompute()
            break
          case ApplicationEvent.SyncTooManyRequests:
            this.syncRateLimited = true
            this.recompute()
            break
          case ApplicationEvent.ExitedOutOfSync:
          case ApplicationEvent.CompletedFullSync:
            this.syncFailing = false
            this.syncRateLimited = false
            this.recompute()
            break
          case ApplicationEvent.SignedIn:
          case ApplicationEvent.SignedOut:
          case ApplicationEvent.Started:
          case ApplicationEvent.LocalDataLoaded:
            this.recompute()
            break
          default:
            break
        }
      }),
    )

    // React to the re-login-dismissed flag flipping (drives "Sign in needed").
    this.disposers.push(
      reaction(
        () => this.application.accountMenuController.reloginPromptDismissed,
        () => this.recompute(),
      ),
    )

    const onOnline = () => this.recompute()
    const onOffline = () => this.recompute()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    this.disposers.push(() => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    })

    this.recompute()
  }

  get count(): number {
    return this.notifications.length
  }

  /**
   * Builds the current notification list from live app signals, then prunes
   * dismissals whose condition no longer holds (so the alert re-surfaces next
   * time) and filters out the still-active dismissals.
   */
  private recompute = (): void => {
    const candidates = this.buildCandidates()
    const candidateIds = new Set(candidates.map((notification) => notification.id))

    // Forget dismissals whose condition has cleared, so they re-surface later.
    for (const dismissedId of Array.from(this.dismissedIds)) {
      if (!candidateIds.has(dismissedId)) {
        this.dismissedIds.delete(dismissedId)
      }
    }

    const next = candidates.filter((notification) => !this.dismissedIds.has(notification.id))

    runInAction(() => {
      this.notifications = next
    })
  }

  private buildCandidates(): AppNotification[] {
    const notifications: AppNotification[] = []
    const application = this.application

    const signedOut = application.sessions.isSignedOut()
    const loginNeeded = application.accountMenuController.reloginPromptDismissed === true
    const offline = typeof navigator !== 'undefined' ? !navigator.onLine : false

    // Re-auth needed takes precedence over the generic "not backed up" nag.
    if (loginNeeded) {
      notifications.push({
        id: 'login-needed',
        title: 'Sign in needed',
        message: "You're signed out — sign in to resume syncing your notes.",
        level: 'warning',
        action: {
          label: 'Sign in',
          run: () => application.accountMenuController.openSignIn(),
        },
        dismissable: false,
      })
    } else if (signedOut) {
      notifications.push({
        id: 'no-account',
        title: 'Data not backed up',
        message: 'Sign in or back up to protect your notes — they currently exist only on this device.',
        level: 'warning',
        action: {
          label: 'Sign in / register',
          run: () => application.accountMenuController.setShow(true),
        },
        dismissable: true,
      })
    }

    if (offline) {
      notifications.push({
        id: 'offline',
        title: "You're offline",
        message: 'Changes are saved locally and will sync when you reconnect.',
        level: 'info',
        dismissable: true,
      })
    }

    if (this.syncRateLimited) {
      notifications.push({
        id: 'sync-rate-limited',
        title: 'Syncing paused',
        message: 'Too many sync requests — syncing will resume automatically in a moment.',
        level: 'warning',
        dismissable: true,
      })
    } else if (this.syncFailing) {
      notifications.push({
        id: 'sync-failed',
        title: 'Sync problem',
        message: "Your notes couldn't be synced with the server. They're safe locally and will retry automatically.",
        level: 'error',
        dismissable: true,
      })
    }

    return notifications
  }

  dismiss = (id: string): void => {
    this.dismissedIds.add(id)
    runInAction(() => {
      this.notifications = this.notifications.filter((notification) => notification.id !== id)
    })
  }

  override deinit(): void {
    super.deinit()
    ;(this.application as unknown) = undefined
  }
}
