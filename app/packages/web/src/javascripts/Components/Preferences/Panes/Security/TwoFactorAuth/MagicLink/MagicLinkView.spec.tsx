/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import MagicLinkView from './MagicLinkView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type MockApplication = {
  sessions: { getUser: jest.Mock }
  mfa: {
    isMagicLinkEnabled: jest.Mock
    setMagicLinkEnabled: jest.Mock
  }
}

const makeApplication = (): MockApplication => ({
  sessions: {
    getUser: jest.fn().mockReturnValue({ uuid: 'user-uuid' }),
  },
  mfa: {
    isMagicLinkEnabled: jest.fn().mockResolvedValue(false),
    setMagicLinkEnabled: jest
      .fn()
      .mockRejectedValue(new Error('Email delivery is not configured. Magic-link sign-in cannot be enabled.')),
  },
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderWith = async (application: MockApplication) => {
  await act(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(createElement(MagicLinkView, { application: application as any }))
  })
}

describe('MagicLinkView', () => {
  it('states that email delivery is required and rolls back a rejected enable request', async () => {
    const application = makeApplication()
    await renderWith(application)

    expect(container.textContent).toContain('Email delivery must be configured and available on your server')
    expect(container.textContent).toContain('verification codes are never shown on the sign-in screen')

    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(toggle).not.toBeNull()

    await act(async () => {
      toggle?.click()
    })

    expect(application.mfa.setMagicLinkEnabled).toHaveBeenCalledWith(true)
    expect(toggle?.checked).toBe(false)
    expect(container.textContent).toContain('Email delivery is not configured. Magic-link sign-in cannot be enabled.')
  })
})
