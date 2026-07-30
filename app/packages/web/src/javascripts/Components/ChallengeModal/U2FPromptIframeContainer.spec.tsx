/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@/Logging', () => ({
  log: jest.fn(),
  LoggingDomain: { U2F: 'u2f' },
}))

import U2FPromptIframeContainer from './U2FPromptIframeContainer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function sendMessage(source: MessageEventSource | null, origin: string, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { source, origin, data }))
  })
}

describe('U2FPromptIframeContainer message authentication', () => {
  it('rejects a same-origin message from any window except its iframe', () => {
    const onResponse = jest.fn()
    act(() => {
      root.render(
        createElement(U2FPromptIframeContainer, {
          contextData: { username: 'alice@example.com' },
          apiHost: 'https://api.example',
          onResponse,
        }),
      )
    })

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const assertionResponse = { id: 'credential-id' }

    sendMessage(window, window.location.origin, { assertionResponse })
    expect(onResponse).not.toHaveBeenCalled()

    sendMessage(iframe.contentWindow, window.location.origin, { assertionResponse })
    expect(onResponse).toHaveBeenCalledWith(assertionResponse)
  })

  it('sends context only to the iframe and uses an origin-only postMessage target', () => {
    act(() => {
      root.render(
        createElement(U2FPromptIframeContainer, {
          contextData: { username: 'alice@example.com' },
          apiHost: 'https://api.example',
          onResponse: jest.fn(),
        }),
      )
    })

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const postMessage = jest.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation()

    sendMessage(iframe.contentWindow, window.location.origin, { mountedAuthView: true })

    expect(postMessage).toHaveBeenCalledWith(
      { username: 'alice@example.com', apiHost: 'https://api.example' },
      window.location.origin,
    )
  })
})
