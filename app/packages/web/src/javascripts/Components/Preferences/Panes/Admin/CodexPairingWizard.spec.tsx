/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success' },
}))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

import CodexPairingWizard from './CodexPairingWizard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STATE = Buffer.alloc(32, 3).toString('base64url')
const AUTHORIZE_URL = `https://auth.example.test/oauth/authorize?state=${STATE}&client_id=client`

let container: HTMLElement
let root: Root

const flush = async (times = 5) => {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await Promise.resolve()
    }
  })
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label)

const setInput = async (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

describe('CodexPairingWizard security and per-id lifecycle', () => {
  it('polls the requested id, displays only the sanitized provider origin, and opens without an opener', async () => {
    const application = {
      assistantSubscriptionStatus: jest.fn().mockResolvedValue({
        paired: false,
        subscriptionId: 'default',
        profileReferencesKnown: true,
      }),
      assistantSubscriptionStart: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: { authorizeUrl: AUTHORIZE_URL, state: STATE, subscriptionId: 'team-a' },
      }),
      serverJsonRequest: jest.fn(),
      assistantSubscriptionUnpair: jest.fn(),
    }
    const open = jest.spyOn(window, 'open').mockReturnValue(null)

    await act(async () => {
      root.render(createElement(CodexPairingWizard, { application: application as never }))
    })
    await flush()

    const idInput = container.querySelector('input[placeholder^="Subscription id"]') as HTMLInputElement
    await setInput(idInput, 'team-a')
    await act(async () => button('Generate authorization link')?.click())
    await flush()

    expect(application.assistantSubscriptionStart).toHaveBeenCalledWith('team-a')
    expect(container.textContent).toContain('https://auth.example.test')
    expect(container.textContent).not.toContain(STATE)
    expect(container.textContent).not.toContain('/oauth/authorize')
    expect(container.textContent).not.toContain('client_id')

    const codeInput = container.querySelector('input[placeholder="Paste authorization code"]') as HTMLInputElement
    expect(codeInput.getAttribute('type')).toBe('password')
    expect(codeInput.getAttribute('autocomplete')).toBe('off')
    expect(codeInput.getAttribute('spellcheck')).toBe('false')
    expect(button('Complete pairing')).toBeDefined()

    await act(async () => button('Open in new tab')?.click())
    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank', expect.stringContaining('noopener,noreferrer'))

    await act(async () => button('Check pairing')?.click())
    expect(application.assistantSubscriptionStatus).toHaveBeenLastCalledWith('team-a')
  })

  it('blocks client-side unpair when profile-reference status is unknown', async () => {
    const application = {
      assistantSubscriptionStatus: jest.fn().mockResolvedValue({
        paired: true,
        subscriptionId: 'default',
        profileReferencesKnown: false,
      }),
      assistantSubscriptionStart: jest.fn(),
      serverJsonRequest: jest.fn(),
      assistantSubscriptionUnpair: jest.fn(),
    }

    await act(async () => {
      root.render(createElement(CodexPairingWizard, { application: application as never }))
    })
    await flush()
    await act(async () => button('Unpair')?.click())
    await flush()

    expect(application.assistantSubscriptionUnpair).not.toHaveBeenCalled()
    expect(container.textContent).toContain('unpairing is blocked')
  })

  it('rejects surrounding whitespace instead of silently rewriting a subscription id', async () => {
    const application = {
      assistantSubscriptionStatus: jest.fn().mockResolvedValue({
        paired: false,
        subscriptionId: 'default',
        profileReferencesKnown: true,
      }),
      assistantSubscriptionStart: jest.fn(),
      serverJsonRequest: jest.fn(),
      assistantSubscriptionUnpair: jest.fn(),
    }

    await act(async () => {
      root.render(createElement(CodexPairingWizard, { application: application as never }))
    })
    await flush()

    const idInput = container.querySelector('input[placeholder^="Subscription id"]') as HTMLInputElement
    await setInput(idInput, ' team-a ')
    await act(async () => button('Generate authorization link')?.click())
    await flush()

    expect(application.assistantSubscriptionStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Use 1-128 letters')
  })

  it('directs an operator to the supported installer when pairing storage is unavailable', async () => {
    const application = {
      assistantSubscriptionStatus: jest.fn().mockResolvedValue({
        paired: false,
        subscriptionId: 'default',
        profileReferencesKnown: true,
      }),
      assistantSubscriptionStart: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      serverJsonRequest: jest.fn(),
      assistantSubscriptionUnpair: jest.fn(),
    }

    await act(async () => {
      root.render(createElement(CodexPairingWizard, { application: application as never }))
    })
    await flush()
    await act(async () => button('Generate authorization link')?.click())
    await flush()

    expect(container.textContent).toContain('rerun or update the supported installer')
    expect(container.textContent).toContain('restore its original installation secrets')
    expect(container.textContent).not.toContain('set ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY')
  })
})
