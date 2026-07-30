/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import OtherSessionsSignOut from './OtherSessionsSignOut'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ApplicationMock = ReturnType<typeof makeApplication>

const makeApplication = () => ({
  accountMenuController: {
    otherSessionsSignOut: true,
    setOtherSessionsSignOut: jest.fn(),
  },
  revokeAllOtherSessions: jest.fn(),
  alerts: {
    alert: jest.fn().mockResolvedValue(undefined),
  },
})

let container: HTMLElement
let root: Root
let application: ApplicationMock

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  application = makeApplication()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderDialog = async () => {
  await act(async () => {
    root.render(createElement(OtherSessionsSignOut, { application: application as never }))
  })
}

const clickEndSessions = async () => {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('End Sessions'),
  )
  expect(button).toBeDefined()

  await act(async () => {
    button?.click()
  })
}

describe('OtherSessionsSignOut', () => {
  it('closes and announces success only after every requested session is confirmed revoked', async () => {
    application.revokeAllOtherSessions.mockResolvedValue({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: ['other-a', 'other-b'],
      failures: [],
      sessions: [],
    })

    await renderDialog()
    await clickEndSessions()

    expect(application.accountMenuController.setOtherSessionsSignOut).toHaveBeenCalledWith(false)
    expect(application.alerts.alert).toHaveBeenCalledWith(
      'You have successfully ended your sessions on other devices.',
      undefined,
      'Finish',
    )
  })

  it('keeps the dialog open and reports a partial failure without announcing success', async () => {
    application.revokeAllOtherSessions.mockResolvedValue({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: ['other-a'],
      failures: [{ sessionId: 'other-b', message: 'Server refused the request.' }],
      sessions: [],
    })

    await renderDialog()
    await clickEndSessions()

    expect(application.accountMenuController.setOtherSessionsSignOut).not.toHaveBeenCalled()
    expect(application.alerts.alert).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      '1 of 2 other sessions were ended. 1 session could not be ended. Please try again.',
    )
  })

  it('reports a total failure without closing or announcing success', async () => {
    application.revokeAllOtherSessions.mockResolvedValue({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: [],
      failures: [
        { sessionId: 'other-a', message: 'Server refused the request.' },
        { sessionId: 'other-b', message: 'Server refused the request.' },
      ],
      sessions: [],
    })

    await renderDialog()
    await clickEndSessions()

    expect(application.accountMenuController.setOtherSessionsSignOut).not.toHaveBeenCalled()
    expect(application.alerts.alert).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'No other sessions were ended. 2 of 2 sessions could not be ended. Please try again.',
    )
  })

  it('surfaces a rejected list request without closing or announcing success', async () => {
    application.revokeAllOtherSessions.mockRejectedValue(new Error('Network unavailable'))

    await renderDialog()
    await clickEndSessions()

    expect(application.accountMenuController.setOtherSessionsSignOut).not.toHaveBeenCalled()
    expect(application.alerts.alert).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Other sessions could not be ended: Network unavailable',
    )
  })
})
