/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useCaptcha } from './useCaptcha'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CaptchaHarness = ({ url, callback }: { url: string; callback: (token: string) => void }) =>
  useCaptcha(url, callback)

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

describe('useCaptcha message authentication', () => {
  it('requires both the configured origin and the exact captcha iframe window', () => {
    const callback = jest.fn()
    act(() => {
      root.render(createElement(CaptchaHarness, { url: 'https://captcha.example/challenge', callback }))
    })

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.contentWindow).not.toBeNull()

    sendMessage(window, 'https://captcha.example', { type: 'captcha-complete', token: 'spoofed' })
    sendMessage(iframe.contentWindow, 'https://attacker.example', { type: 'captcha-complete', token: 'spoofed' })
    expect(callback).not.toHaveBeenCalled()

    sendMessage(iframe.contentWindow, 'https://captcha.example', {
      type: 'captcha-complete',
      token: 'genuine',
    })
    expect(callback).toHaveBeenCalledWith('genuine')
  })

  it('updates the expected origin when the captcha iframe navigates', () => {
    const callback = jest.fn()
    act(() => {
      root.render(createElement(CaptchaHarness, { url: 'https://captcha-a.example/challenge', callback }))
    })
    const iframe = container.querySelector('iframe') as HTMLIFrameElement

    act(() => {
      root.render(createElement(CaptchaHarness, { url: 'https://captcha-b.example/challenge', callback }))
    })

    sendMessage(iframe.contentWindow, 'https://captcha-a.example', {
      type: 'captcha-complete',
      token: 'stale',
    })
    expect(callback).not.toHaveBeenCalled()

    sendMessage(iframe.contentWindow, 'https://captcha-b.example', {
      type: 'captcha-complete',
      token: 'fresh',
    })
    expect(callback).toHaveBeenCalledWith('fresh')
  })

  it('rejects opaque, local-file, and remote plaintext captcha origins', () => {
    const callback = jest.fn()

    for (const url of [
      'data:text/html,captcha',
      'blob:https://captcha.example/id',
      'file:///tmp/captcha.html',
      'http://captcha.example/challenge',
    ]) {
      act(() => {
        root.render(createElement(CaptchaHarness, { url, callback }))
      })
      expect(container.querySelector('iframe')).toBeNull()
    }
  })

  it('allows explicit HTTP loopback development origins', () => {
    const callback = jest.fn()
    act(() => {
      root.render(createElement(CaptchaHarness, { url: 'http://127.0.0.1:3000/challenge', callback }))
    })

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    sendMessage(iframe.contentWindow, 'http://127.0.0.1:3000', {
      type: 'captcha-complete',
      token: 'local-dev',
    })

    expect(callback).toHaveBeenCalledWith('local-dev')
  })
})
