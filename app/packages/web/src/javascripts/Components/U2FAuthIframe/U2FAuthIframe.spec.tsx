/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/Logging', () => ({
  log: jest.fn(),
  LoggingDomain: { U2F: 'u2f' },
}))

jest.mock('@simplewebauthn/browser', () => ({
  startAuthentication: jest.fn(),
}))

import U2FAuthIframe from './U2FAuthIframe'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let fetchMock: jest.Mock
let parentPostMessage: jest.SpyInstance

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = jest.fn().mockResolvedValue({
    json: jest.fn().mockResolvedValue({}),
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  })
  parentPostMessage = jest.spyOn(window.parent, 'postMessage').mockImplementation()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  parentPostMessage.mockRestore()
  container.remove()
})

function sendMessage(source: MessageEventSource | null, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { source, origin: 'file://', data }))
  })
}

async function clickAuthenticate(): Promise<void> {
  const button = container.querySelector('button') as HTMLButtonElement
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

describe('U2FAuthIframe message authentication', () => {
  it('rejects a correctly-originated message from a sibling frame', async () => {
    act(() => {
      root.render(createElement(U2FAuthIframe))
    })
    const sibling = document.createElement('iframe')
    document.body.appendChild(sibling)

    sendMessage(sibling.contentWindow, {
      username: 'victim@example.com',
      apiHost: 'https://attacker.example',
    })
    await clickAuthenticate()

    expect(fetchMock).not.toHaveBeenCalled()
    sibling.remove()
  })

  it('accepts credentials only from its exact parent window', async () => {
    act(() => {
      root.render(createElement(U2FAuthIframe))
    })

    sendMessage(window.parent, {
      username: 'alice@example.com',
      apiHost: 'https://api.example',
    })
    await clickAuthenticate()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/v1/authenticators/generate-authentication-options',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
