/**
 * @jest-environment jsdom
 *
 * "Achievement unlocked" told the user nothing about WHICH achievement they had
 * earned: the popover row renders titles only, so every unlock looked identical.
 * Entries now carry a `subtitle` holding the achievement's name, rendered under
 * the title on both notification surfaces.
 *
 * A controller unit test alone would not prove this — tsc and green unit tests
 * have shipped invisible UI in this repo before. So this spec drives the REAL
 * NotificationsPanel and NotificationsView in jsdom, off a REAL
 * NotificationsController fed by the REAL persisted unlock feed, and asserts the
 * rendered text equals the catalog name (an assertion that merely found a
 * subtitle element would pass on an empty string).
 *
 * No @testing-library in this package: React is driven directly via
 * react-dom/client createRoot + act, mirroring CollaborationStatusIndicator.spec.
 */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  ToastType: { Regular: 'regular', Success: 'success', Error: 'error' },
  addToast: jest.fn(() => 'toast-1'),
  dismissToast: jest.fn(),
}))

// The popover's positioning/animation machinery is irrelevant here; render its
// children inline so the rows themselves are under test.
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => {
    return open ? createElement('div', { 'data-testid': 'notifications-popover' }, children) : null
  },
}))

import { ACHIEVEMENTS } from '@/Achievements/achievementDefinitions'
import { WebApplication } from '@/Application/WebApplication'
import { NotificationsController } from '@/Controllers/NotificationsController'
import { recordAchievementNotification } from '@/Notifications/achievementNotifications'
import NotificationsPanel from './NotificationsPanel'
import NotificationsView from './NotificationsView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const [FIRST, SECOND, THIRD] = ACHIEVEMENTS

const makeApplication = (controllerRef: { current?: NotificationsController }) =>
  ({
    events: {},
    addEventObserver: () => () => undefined,
    // Signed in + online, so achievement rows are the ONLY notifications listed.
    sessions: { isSignedOut: () => false },
    accountMenuController: { reloginPromptDismissed: false, openSignIn: () => undefined, setShow: () => undefined },
    paneController: { openPaneTab: () => undefined },
    get notificationsController() {
      return controllerRef.current
    },
  }) as unknown as WebApplication

let container: HTMLElement
let root: Root
let controller: NotificationsController

/** Elements whose own text is exactly `text` (leaf nodes — a real rendered line). */
const leavesWithText = (text: string): Element[] =>
  Array.from(container.querySelectorAll('div, span')).filter(
    (element) => element.children.length === 0 && element.textContent === text,
  )

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const ref: { current?: NotificationsController } = {}
  controller = new NotificationsController(makeApplication(ref))
  ref.current = controller
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  controller.deinit()
  localStorage.clear()
})

const renderPanel = async (): Promise<void> => {
  await act(async () => {
    root.render(
      createElement(NotificationsPanel, {
        controller,
        open: true,
        anchorElement: { current: null },
        togglePopover: () => undefined,
      }),
    )
  })
}

const renderTab = async (): Promise<void> => {
  const ref: { current?: NotificationsController } = { current: controller }
  await act(async () => {
    root.render(createElement(NotificationsView, { application: makeApplication(ref) }))
  })
}

describe('achievement unlock notification names the achievement', () => {
  it('renders the achievement name as a subtitle line in the compact popover row', async () => {
    recordAchievementNotification(FIRST.id)
    await renderPanel()

    expect(container.textContent).toContain('Achievement unlocked')
    // The point of the change: the actual name is on screen, on its own line.
    const subtitles = leavesWithText(FIRST.name)
    expect(subtitles).toHaveLength(1)
    const subtitle = subtitles[0]
    expect(subtitle.textContent?.trim()).toBe(FIRST.name)
    expect(subtitle.textContent?.trim().length).toBeGreaterThan(0)
    // Long names must clip inside the narrow popover, with the full text on hover.
    expect(subtitle.className).toContain('truncate')
    expect(subtitle.getAttribute('title')).toBe(FIRST.name)
  })

  it('renders the name in the full Notifications tab too, without repeating it', async () => {
    recordAchievementNotification(FIRST.id)
    await renderTab()

    expect(container.textContent).toContain('Achievement unlocked')
    expect(leavesWithText(FIRST.name)).toHaveLength(1)
    // Description still shown, as the message, below the name.
    expect(container.textContent).toContain(FIRST.description)
    // The name appears exactly once in the row's text (it is no longer prefixed
    // onto the message as well).
    const occurrences = (container.textContent ?? '').split(FIRST.name).length - 1
    expect(occurrences).toBe(1)
  })

  it('names each achievement when several unlock at once (one row each)', async () => {
    recordAchievementNotification(FIRST.id)
    recordAchievementNotification(SECOND.id)
    recordAchievementNotification(THIRD.id)
    await renderPanel()

    for (const achievement of [FIRST, SECOND, THIRD]) {
      expect(leavesWithText(achievement.name)).toHaveLength(1)
    }
    // Three distinct rows, newest unlock first — nothing is collapsed or dropped.
    expect(leavesWithText('Achievement unlocked')).toHaveLength(3)
    const text = container.textContent ?? ''
    expect(text.indexOf(THIRD.name)).toBeLessThan(text.indexOf(SECOND.name))
    expect(text.indexOf(SECOND.name)).toBeLessThan(text.indexOf(FIRST.name))
  })

  it('leaves non-achievement notifications with no subtitle line at all', async () => {
    controller.deinit()
    controller = new NotificationsController({
      events: {},
      addEventObserver: () => () => undefined,
      sessions: { isSignedOut: () => true },
      accountMenuController: { reloginPromptDismissed: false, openSignIn: () => undefined, setShow: () => undefined },
      paneController: { openPaneTab: () => undefined },
    } as unknown as WebApplication)
    await renderPanel()

    expect(container.textContent).toContain('Data not backed up')
    expect(controller.notifications.every((notification) => notification.subtitle === undefined)).toBe(true)
  })
})
