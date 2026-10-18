import { ApplicationEvent, ContentType, VaultLockServiceEvent } from '@standardnotes/snjs'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { ALL_NOTE_MEMBERS_RECIPIENT } from '@/Comments/CommentPreferences'
import { WebApplication } from '@/Application/WebApplication'
import { NotificationsController } from './NotificationsController'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { ACHIEVEMENTS } from '@/Achievements/achievementDefinitions'
import { listAchievementNotifications, recordAchievementNotification } from '@/Notifications/achievementNotifications'
jest.mock('@/Comments/CommentAuthorship', () => ({ readDisplayNoteComments: jest.fn() }))

jest.mock('@standardnotes/toast', () => ({
  ToastType: {
    Regular: 'regular',
    Success: 'success',
    Error: 'error',
    Loading: 'loading',
    Progress: 'progress',
  },
  addToast: jest.fn(),
  dismissToast: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const toastMock = jest.requireMock('@standardnotes/toast') as {
  addToast: jest.Mock
  dismissToast: jest.Mock
}

type EventObserver = (event: ApplicationEvent) => Promise<void> | void

const createApplication = (options?: { signedOut?: boolean }) => {
  const observers: EventObserver[] = []
  const application = {
    events: {},
    addEventObserver: (observer: EventObserver) => {
      observers.push(observer)
      return () => {}
    },
    sessions: {
      isSignedOut: jest.fn(() => options?.signedOut ?? true),
    },
    accountMenuController: {
      reloginPromptDismissed: false,
      openSignIn: jest.fn(),
      setShow: jest.fn(),
    },
    paneController: {
      openPaneTab: jest.fn(),
    },
    openPreferences: jest.fn(),
  }
  return { application: application as unknown as WebApplication, observers }
}

const remind = (controller: NotificationsController) =>
  (controller as unknown as { maybeRemind: () => void }).maybeRemind()

describe('NotificationsController', () => {
  let controller: NotificationsController | undefined

  beforeEach(() => {
    localStorage.clear()
    controller = undefined
    // resetMocks is on globally, so (re)install implementations per test.
    let nextToastId = 0
    toastMock.addToast.mockImplementation(() => `toast-${++nextToastId}`)
  })

  afterEach(() => {
    controller?.deinit()
  })

  it('receives shared-comment notifications through note streams and clears them on removal or sign-out', () => {
    const { application, observers } = createApplication({ signedOut: false })
    let comments: unknown[] = []
    const streams = new Map<string, () => void>()
    let note = { uuid: 'note-a', shared_vault_uuid: 'vault-a', title: 'Planning' }
    jest.mocked(readDisplayNoteComments).mockImplementation(() => ({ comments, quarantinedCount: 0 }) as never)
    Object.assign(application, {
      items: {
        getItems: () => [note],
        streamItems: (type: string, callback: () => void) => {
          streams.set(type, callback)
          return () => streams.delete(type)
        },
      },
      isAuthorizedToRenderItem: () => true,
    })
    Object.assign(application.sessions, { getUser: () => ({ uuid: 'self' }) })
    localStorage.setItem('standardnotes.notifications.read.v1', JSON.stringify(['comment:self:note-a:comment-a']))
    controller = new NotificationsController(application)
    expect(controller.notifications).toEqual([])
    comments = [
      {
        id: 'comment-a',
        verifiedAuthorUuid: 'other',
        authorshipStatus: 'verified',
        displayAuthorName: 'Peer',
        mentions: [ALL_NOTE_MEMBERS_RECIPIENT],
      },
    ]
    // A note stream carries a new immutable model after receiving its encrypted comment.
    note = { ...note }
    streams.get(ContentType.TYPES.Note)!()
    expect(controller.notifications).toHaveLength(1)
    expect(controller.unreadCount).toBe(0)
    controller.updateSettings({ sources: { comments: false } })
    expect(controller.notifications).toEqual([])
    controller.updateSettings({ sources: { comments: true } })
    expect(controller.notifications).toHaveLength(1)
    expect(controller.unreadCount).toBe(0)
    comments = []
    note = { ...note }
    streams.get(ContentType.TYPES.Note)!()
    expect(controller.notifications).toEqual([])
    comments = [
      {
        id: 'comment-b',
        verifiedAuthorUuid: 'other',
        authorshipStatus: 'verified',
        displayAuthorName: 'Peer',
        mentions: [ALL_NOTE_MEMBERS_RECIPIENT],
      },
    ]
    streams.get(ContentType.TYPES.TrustedContact)!()
    expect(controller.notifications).toHaveLength(1)
    ;(application.sessions.isSignedOut as jest.Mock).mockReturnValue(true)
    observers.forEach((observer) => void observer(ApplicationEvent.SignedOut))
    expect(controller.notifications.some((entry) => entry.id.startsWith('comment:'))).toBe(false)
    controller.deinit()
    controller = undefined
    expect(streams.size).toBe(0)
  })

  it('projects only changed notes after initialization and invalidates on trust changes', () => {
    const { application, observers } = createApplication({ signedOut: false })
    const notes = Array.from({ length: 100 }, (_, index) => ({
      uuid: `note-${index}`,
      shared_vault_uuid: 'vault',
      title: 'Title',
    }))
    const streams = new Map<string, (change?: unknown) => void>()
    const getItems = jest.fn(() => notes)
    let vaultEvent: (event: VaultLockServiceEvent) => void = () => undefined
    const stopVaultObserver = jest.fn()
    Object.assign(application, {
      vaultLocks: {
        addEventObserver: (callback: typeof vaultEvent) => {
          vaultEvent = callback
          return stopVaultObserver
        },
      },
    })
    const authorize = jest.fn(() => true)
    Object.assign(application, {
      items: {
        getItems,
        streamItems: (type: string, callback: (change?: unknown) => void) => {
          streams.set(type, callback)
          return () => streams.delete(type)
        },
      },
      isAuthorizedToRenderItem: authorize,
    })
    Object.assign(application.sessions, { getUser: () => ({ uuid: 'self' }) })
    jest.mocked(readDisplayNoteComments).mockReturnValue({
      comments: [
        {
          id: 'comment',
          verifiedAuthorUuid: 'other',
          authorshipStatus: 'verified',
          displayAuthorName: 'Peer',
          mentions: ['self'],
        },
      ],
      quarantinedCount: 0,
    } as never)
    controller = new NotificationsController(application)
    expect(controller.notifications).toHaveLength(100)
    getItems.mockClear()
    authorize.mockClear()
    const changed = { ...notes[0], title: 'Updated' }
    streams.get(ContentType.TYPES.Note)!({ changed: [changed], inserted: [], removed: [] })
    expect(getItems).not.toHaveBeenCalled()
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(controller.notifications.find((entry) => entry.id.includes(':note-0:'))?.subtitle).toBe('Updated')
    streams.get(ContentType.TYPES.Note)!({ changed: [], inserted: [], removed: [changed] })
    expect(controller.notifications).toHaveLength(99)
    authorize.mockReturnValue(false)
    streams.get(ContentType.TYPES.TrustedContact)!()
    expect(getItems).toHaveBeenCalledTimes(1)
    expect(controller.notifications).toHaveLength(0)
    authorize.mockReturnValue(true)
    observers.forEach((observer) => void observer(ApplicationEvent.UnprotectedSessionBegan))
    expect(controller.notifications).toHaveLength(100)
    authorize.mockReturnValue(false)
    observers.forEach((observer) => void observer(ApplicationEvent.UnprotectedSessionExpired))
    expect(controller.notifications).toHaveLength(0)
    authorize.mockReturnValue(true)
    vaultEvent(VaultLockServiceEvent.VaultUnlocked)
    expect(controller.notifications).toHaveLength(100)
    authorize.mockReturnValue(false)
    vaultEvent(VaultLockServiceEvent.VaultLocked)
    expect(controller.notifications).toHaveLength(0)
    controller.deinit()
    controller = undefined
    expect(stopVaultObserver).toHaveBeenCalledTimes(1)
  })

  it('opens actual sync recovery and switches to reauthentication if the session changes before clicking', () => {
    const { application, observers } = createApplication({ signedOut: false })
    controller = new NotificationsController(application)
    observers.forEach((observer) => void observer(ApplicationEvent.FailedSync))
    const notification = controller.notifications.find((entry) => entry.id === 'sync-failed')!
    expect(notification.action?.label).toBe('Resolve sync')
    notification.action!.run()
    expect(application.openPreferences).toHaveBeenCalledWith('sync')
    ;(application.sessions.isSignedOut as jest.Mock).mockReturnValue(true)
    notification.action!.run()
    expect(application.accountMenuController.openSignIn).toHaveBeenCalledTimes(1)
  })

  it('offers an action for rate-limited sync without immediately dispatching another request', () => {
    const { application, observers } = createApplication({ signedOut: false })
    controller = new NotificationsController(application)
    observers.forEach((observer) => void observer(ApplicationEvent.SyncTooManyRequests))
    controller.notifications.find((entry) => entry.id === 'sync-rate-limited')!.action!.run()
    expect(application.openPreferences).toHaveBeenCalledWith('sync')
  })

  it('provides meaningful actions for connectivity, backup, login and achievement notifications', () => {
    const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      const { application } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)
      expect(controller.notifications.every((notification) => Boolean(notification.action?.label))).toBe(true)
      controller.notifications.find((notification) => notification.id === 'no-account')!.action!.run()
      expect(application.accountMenuController.setShow).toHaveBeenCalledWith(true)
      controller.notifications.find((notification) => notification.id === 'offline')!.action!.run()
      expect(application.accountMenuController.openSignIn).toHaveBeenCalled()
      recordAchievementNotification(ACHIEVEMENTS[0].id)
      controller.notifications.find((notification) => notification.id.startsWith('achievement:'))!.action!.run()
      expect(application.openPreferences).toHaveBeenCalledWith('achievements')
    } finally {
      online.mockRestore()
    }
  })

  it('routes blocked vault assignments to the rule resolver without exposing internal identifiers', () => {
    const { application } = createApplication({ signedOut: false })
    Object.assign(application, {
      autoVaultRulesService: { problems: [{ noteUuid: 'private-opaque-note', reason: 'conflict' }] },
    })
    controller = new NotificationsController(application)
    const notification = controller.notifications.find((entry) => entry.id === 'vault-rule-problems')!
    expect(notification.message).not.toContain('private-opaque-note')
    notification.action!.run()
    expect(application.openPreferences).toHaveBeenCalledWith('vaults')
  })

  it('surfaces the signed-out alert as unread, with badge equal to listed unread rows', () => {
    const { application } = createApplication({ signedOut: true })
    controller = new NotificationsController(application)

    expect(controller.notifications.map((n) => n.id)).toContain('no-account')
    expect(controller.unreadCount).toBe(1)
    // The unread badge may never exceed what the list actually shows.
    expect(controller.unreadCount).toBeLessThanOrEqual(controller.notifications.length)
  })

  it('markAllRead zeroes the unread count, keeps the list, and persists', () => {
    const { application } = createApplication({ signedOut: true })
    controller = new NotificationsController(application)

    controller.markAllRead()
    expect(controller.unreadCount).toBe(0)
    expect(controller.notifications.length).toBe(1)
    expect(controller.isRead('no-account')).toBe(true)

    // A fresh controller (new session) re-reads the persisted read ids.
    const second = new NotificationsController(createApplication({ signedOut: true }).application)
    expect(second.unreadCount).toBe(0)
    second.deinit()
  })

  it('dismiss removes the entry from both the list and the unread count', () => {
    const { application } = createApplication({ signedOut: true })
    controller = new NotificationsController(application)

    controller.dismiss('no-account')
    expect(controller.notifications).toHaveLength(0)
    expect(controller.unreadCount).toBe(0)
  })

  it('forgets read state when the condition clears so it re-surfaces as new', () => {
    const { application, observers } = createApplication({ signedOut: true })
    controller = new NotificationsController(application)
    controller.markAllRead()

    ;(application.sessions.isSignedOut as jest.Mock).mockReturnValue(false)
    observers.forEach((observer) => void observer(ApplicationEvent.SignedIn))
    expect(controller.notifications).toHaveLength(0)
    expect(controller.unreadCount).toBe(0)

    ;(application.sessions.isSignedOut as jest.Mock).mockReturnValue(true)
    observers.forEach((observer) => void observer(ApplicationEvent.SignedOut))
    expect(controller.unreadCount).toBe(1)
  })

  describe('achievement notifications', () => {
    const achievement = ACHIEVEMENTS[0]

    it('shows a recorded unlock as an unread trophy entry', () => {
      const { application } = createApplication({ signedOut: false })
      controller = new NotificationsController(application)
      expect(controller.unreadCount).toBe(0)

      recordAchievementNotification(achievement.id)

      const entry = controller.notifications.find((n) => n.id === `achievement:${achievement.id}`)
      expect(entry).toBeDefined()
      expect(entry?.title).toBe('Achievement unlocked')
      // The generic title is useless on its own — the entry must name WHICH
      // achievement, in the subtitle (the popover renders titles + subtitles only).
      expect(entry?.subtitle).toBe(achievement.name)
      expect(entry?.subtitle).not.toBe('')
      // ...and the name is not repeated inside the message alongside it.
      expect(entry?.message).toBe(achievement.description)
      expect(entry?.icon).toBeDefined()
      expect(entry?.dismissable).toBe(true)
      expect(controller.unreadCount).toBe(1)
    })

    it('names every achievement separately when several unlock at once', () => {
      const [first, second, third] = ACHIEVEMENTS
      const { application } = createApplication({ signedOut: false })
      controller = new NotificationsController(application)

      recordAchievementNotification(first.id)
      recordAchievementNotification(second.id)
      recordAchievementNotification(third.id)

      const entries = controller!.notifications.filter((n) => n.id.startsWith('achievement:'))
      expect(entries).toHaveLength(3)
      // Newest first, and NOT collapsed into one row or an "and 2 more" summary:
      // each unlock keeps its own name, icon and dismiss affordance.
      expect(entries.map((n) => n.subtitle)).toEqual([third.name, second.name, first.name])
      expect(controller!.unreadCount).toBe(3)

      // Dismissing one leaves the others still named.
      controller!.dismiss(`achievement:${second.id}`)
      const remaining = controller!.notifications.filter((n) => n.id.startsWith('achievement:'))
      expect(remaining.map((n) => n.subtitle)).toEqual([third.name, first.name])
    })

    it('marks achievement entries read when the pane is viewed', () => {
      const { application } = createApplication({ signedOut: false })
      controller = new NotificationsController(application)
      recordAchievementNotification(achievement.id)

      controller.notifyViewOpened('popup')
      expect(controller.unreadCount).toBe(0)
      expect(controller.notifications).toHaveLength(1)
    })

    it('dismissing an achievement entry removes its persisted record', () => {
      const { application } = createApplication({ signedOut: false })
      controller = new NotificationsController(application)
      recordAchievementNotification(achievement.id)

      controller.dismiss(`achievement:${achievement.id}`)
      expect(controller.notifications).toHaveLength(0)
      expect(listAchievementNotifications()).toHaveLength(0)

      // And it stays gone for a fresh controller (unlike condition alerts).
      const second = new NotificationsController(createApplication({ signedOut: false }).application)
      expect(second.notifications).toHaveLength(0)
      second.deinit()
    })
  })

  describe('unread-reminder toast', () => {
    it('does not raise a reminder when nothing is unread', () => {
      const { application } = createApplication({ signedOut: false })
      controller = new NotificationsController(application)

      remind(controller)
      expect(toastMock.addToast).not.toHaveBeenCalled()
    })

    it('raises a reminder while items are unread', () => {
      const { application } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)

      remind(controller)
      expect(toastMock.addToast).toHaveBeenCalledTimes(1)
      expect(toastMock.addToast.mock.calls[0][0].message).toContain('1 unread notification')
    })

    it('never stacks reminders: a new reminder retracts the previous toast', () => {
      const { application } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)

      remind(controller)
      const firstId = toastMock.addToast.mock.results[0].value
      remind(controller)
      expect(toastMock.addToast).toHaveBeenCalledTimes(2)
      expect(toastMock.dismissToast).toHaveBeenCalledWith(firstId)
    })

    it('retracts the reminder as soon as the unread count reaches zero', () => {
      const { application } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)

      remind(controller)
      const toastId = toastMock.addToast.mock.results[0].value
      expect(toastMock.dismissToast).not.toHaveBeenCalledWith(toastId)

      controller.markAllRead()
      expect(toastMock.dismissToast).toHaveBeenCalledWith(toastId)
    })

    it('retracts the reminder when the underlying condition clears', () => {
      const { application, observers } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)

      remind(controller)
      const toastId = toastMock.addToast.mock.results[0].value

      ;(application.sessions.isSignedOut as jest.Mock).mockReturnValue(false)
      observers.forEach((observer) => void observer(ApplicationEvent.SignedIn))
      expect(toastMock.dismissToast).toHaveBeenCalledWith(toastId)
    })

    it('the View action dismisses the toast and opens the Notifications tab', () => {
      const { application } = createApplication({ signedOut: true })
      controller = new NotificationsController(application)

      remind(controller)
      const options = toastMock.addToast.mock.calls[0][0]
      const view = options.actions[0]
      expect(view.label).toBe('View')

      const toastId = toastMock.addToast.mock.results[0].value
      view.handler(toastId)
      expect(toastMock.dismissToast).toHaveBeenCalledWith(toastId)
      expect((application.paneController.openPaneTab as jest.Mock).mock.calls[0][0]).toBe(AppPaneId.Notifications)
    })
  })
})
