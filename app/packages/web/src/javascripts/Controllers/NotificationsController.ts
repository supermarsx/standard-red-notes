import { ApplicationEvent } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import {
  loadNotificationsSettings,
  NotificationsSettings,
  saveNotificationsSettings,
} from '@/Notifications/notificationsSettings'
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

const READ_STORAGE_KEY = 'standardnotes.notifications.read.v1'

/**
 * Standard Red Notes: centralizes the app's scattered alerts/warnings into one
 * observable list surfaced by the "Notifications" sidebar item AND a full
 * "Notifications" editor tab.
 *
 * Sources aggregated (each gated by a per-source setting, except the critical
 * "Sign in needed" re-auth alert which always shows):
 *  - "Data not backed up" — signed-out state.
 *  - "Sign in needed" — involuntary re-auth (always shown).
 *  - "You're offline" — `navigator.onLine` loss.
 *  - "Sync problem" / "Syncing paused" — sync failure / rate limiting.
 *
 * Read/unread: notifications carry a persisted read flag (keyed by their stable
 * condition id). The count bubble reflects UNREAD only. When/how a shown alert
 * becomes read is user-configurable (on popup open, on tab open, or after a
 * visible delay) via {@link NotificationsSettings}. A configurable reminder
 * toast nudges the user when unread alerts are waiting.
 *
 * Recomputation is event-driven (discrete ApplicationEvents) — never a tight
 * poll. Dismissed/read ids whose condition has cleared are forgotten so the
 * alert re-surfaces (and reads as new) next time.
 */
export class NotificationsController extends AbstractViewController {
  notifications: AppNotification[] = []
  settings: NotificationsSettings = loadNotificationsSettings()

  /** Ids the user has dismissed; cleared when the underlying condition clears. */
  private dismissedIds = new Set<string>()
  /** Ids the user has read; persisted; cleared when the condition clears. */
  private readIds = new Set<string>(this.loadReadIds())

  private syncFailing = false
  private syncRateLimited = false

  private reminderTimer: ReturnType<typeof setInterval> | null = null
  private readTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private application: WebApplication) {
    super(application.events)

    makeObservable(this, {
      notifications: observable,
      settings: observable,
      count: computed,
      unreadCount: computed,
      dismiss: action,
      markAllRead: action,
      reloadSettings: action,
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

    this.disposers.push(() => this.clearTimers())

    this.recompute()
    this.restartReminderTimer()
  }

  /** Total active notifications (read + unread). */
  get count(): number {
    return this.notifications.length
  }

  /** Unread active notifications — drives the sidebar count bubble. */
  get unreadCount(): number {
    return this.notifications.filter((notification) => !this.readIds.has(notification.id)).length
  }

  isRead(id: string): boolean {
    return this.readIds.has(id)
  }

  /**
   * Builds the current notification list from live app signals, then prunes
   * dismissals/reads whose condition no longer holds (so the alert re-surfaces,
   * and reads as new, next time) and filters out the still-active dismissals.
   */
  private recompute = (): void => {
    const candidates = this.buildCandidates()
    const candidateIds = new Set(candidates.map((notification) => notification.id))

    // Forget dismissals/reads whose condition has cleared.
    for (const dismissedId of Array.from(this.dismissedIds)) {
      if (!candidateIds.has(dismissedId)) {
        this.dismissedIds.delete(dismissedId)
      }
    }
    let readChanged = false
    for (const readId of Array.from(this.readIds)) {
      if (!candidateIds.has(readId)) {
        this.readIds.delete(readId)
        readChanged = true
      }
    }
    if (readChanged) {
      this.persistReadIds()
    }

    const next = candidates.filter((notification) => !this.dismissedIds.has(notification.id))

    runInAction(() => {
      this.notifications = next
    })
  }

  private buildCandidates(): AppNotification[] {
    const notifications: AppNotification[] = []
    const application = this.application

    if (!this.settings.enabled) {
      return notifications
    }

    const signedOut = application.sessions.isSignedOut()
    const loginNeeded = application.accountMenuController.reloginPromptDismissed === true
    const offline = typeof navigator !== 'undefined' ? !navigator.onLine : false

    // Re-auth needed takes precedence over the generic "not backed up" nag. This
    // critical alert always shows (it is not gated by a source toggle).
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
    } else if (signedOut && this.settings.sources.backup) {
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

    if (offline && this.settings.sources.connectivity) {
      notifications.push({
        id: 'offline',
        title: "You're offline",
        message: 'Changes are saved locally and will sync when you reconnect.',
        level: 'info',
        dismissable: true,
      })
    }

    if (this.settings.sources.sync) {
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
    }

    return notifications
  }

  dismiss = (id: string): void => {
    this.dismissedIds.add(id)
    runInAction(() => {
      this.notifications = this.notifications.filter((notification) => notification.id !== id)
    })
  }

  /** Mark every currently-shown notification read (persisted). */
  markAllRead = (): void => {
    let changed = false
    for (const notification of this.notifications) {
      if (!this.readIds.has(notification.id)) {
        this.readIds.add(notification.id)
        changed = true
      }
    }
    if (changed) {
      this.persistReadIds()
      // Touch the observable so `unreadCount` consumers re-render.
      runInAction(() => {
        this.notifications = [...this.notifications]
      })
    }
  }

  /**
   * Called by the popup/tab when it becomes visible. Applies the configured read
   * trigger: 'popup' marks read from either surface, 'tab' only from the tab, and
   * 'time' starts a delay after which the shown alerts are marked read.
   */
  notifyViewOpened = (source: 'popup' | 'tab'): void => {
    const trigger = this.settings.readTrigger
    if (trigger === 'time') {
      this.startReadTimer()
      return
    }
    if (trigger === 'tab' && source !== 'tab') {
      return
    }
    // 'popup' trigger is satisfied by either surface; 'tab' only by the tab.
    this.markAllRead()
  }

  notifyViewClosed = (): void => {
    this.cancelReadTimer()
  }

  /** Opens the full Notifications tab in the editor tab bar. */
  openTab = (): void => {
    this.application.paneController.openPaneTab(AppPaneId.Notifications)
  }

  /** Re-read persisted settings (after the settings UI saves) and re-apply. */
  reloadSettings = (): void => {
    runInAction(() => {
      this.settings = loadNotificationsSettings()
    })
    this.recompute()
    this.restartReminderTimer()
  }

  /** Persist a settings patch from the in-tab settings UI and re-apply. */
  updateSettings = (
    patch: Partial<Omit<NotificationsSettings, 'sources'>> & { sources?: Partial<NotificationsSettings['sources']> },
  ): void => {
    const next: NotificationsSettings = {
      ...this.settings,
      ...patch,
      sources: { ...this.settings.sources, ...(patch.sources ?? {}) },
    }
    saveNotificationsSettings(next)
    runInAction(() => {
      this.settings = next
    })
    this.recompute()
    this.restartReminderTimer()
  }

  private startReadTimer(): void {
    this.cancelReadTimer()
    this.readTimer = setTimeout(() => {
      this.markAllRead()
    }, this.settings.readAfterSeconds * 1000)
  }

  private cancelReadTimer(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer)
      this.readTimer = null
    }
  }

  private restartReminderTimer(): void {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer)
      this.reminderTimer = null
    }
    if (!this.settings.enabled || !this.settings.reminderEnabled) {
      return
    }
    const intervalMs = this.settings.reminderIntervalMinutes * 60 * 1000
    this.reminderTimer = setInterval(() => this.maybeRemind(), intervalMs)
  }

  private maybeRemind(): void {
    const unread = this.unreadCount
    if (unread <= 0) {
      return
    }
    addToast({
      type: ToastType.Regular,
      message: `You have ${unread} unread notification${unread === 1 ? '' : 's'} — open Notifications to review.`,
      actions: [
        {
          label: 'View',
          handler: () => this.openTab(),
        },
      ],
    })
  }

  private clearTimers(): void {
    this.cancelReadTimer()
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer)
      this.reminderTimer = null
    }
  }

  private loadReadIds(): string[] {
    try {
      const raw = localStorage.getItem(READ_STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  private persistReadIds(): void {
    try {
      localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(Array.from(this.readIds)))
    } catch {
      /* ignore */
    }
  }

  override deinit(): void {
    super.deinit()
    this.clearTimers()
    ;(this.application as unknown) = undefined
  }
}
