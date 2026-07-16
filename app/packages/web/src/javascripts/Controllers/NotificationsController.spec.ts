import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { NotificationsController } from './NotificationsController'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { ACHIEVEMENTS } from '@/Achievements/achievementDefinitions'
import { listAchievementNotifications, recordAchievementNotification } from '@/Notifications/achievementNotifications'

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
      expect(entry?.message).toContain(achievement.name)
      expect(entry?.icon).toBeDefined()
      expect(entry?.dismissable).toBe(true)
      expect(controller.unreadCount).toBe(1)
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
