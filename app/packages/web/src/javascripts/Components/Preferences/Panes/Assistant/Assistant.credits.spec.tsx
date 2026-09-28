/**
 * @jest-environment jsdom
 *
 * Direct-mode remaining-credit render guard (MEMORY: verify UI render paths).
 *
 * Direct is the DEFAULT connection mode and is where a self-hoster's own
 * OpenRouter key actually lives, so this is the half the request was really
 * about. A green suite and a clean tsc do not prove the control appears, so this
 * drives the REAL preferences pane in jsdom and reads the text back.
 *
 * The key never leaves the browser here — it is the same credential Direct mode
 * already sends to the same host on every turn — so the assertions below also
 * pin that the lookup goes straight to the provider and never to our server.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

// Heavy children that are irrelevant to the credit row and drag in editors,
// audio and native bridges.
jest.mock('@/Components/Assistant/AgentRuntimeSettings', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/Components/Narration/NarrationSettings', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/Components/AudioRecorder/SttModelSettings', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: () => null,
}))

import Assistant from './Assistant'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PREFERENCES: Record<string, unknown> = {}

const makeApplication = (preferences: Record<string, unknown>) => {
  Object.assign(PREFERENCES, preferences)
  return {
    getPreference: (key: string, fallback: unknown) => PREFERENCES[key] ?? fallback,
    setPreference: jest.fn().mockResolvedValue(undefined),
    addEventObserver: jest.fn(() => () => undefined),
    sessions: {
      isSignedIn: () => true,
      getUser: () => ({ uuid: 'user-uuid' }),
      getSession: () => undefined,
    },
    featuresController: { isAdminUser: () => false },
    legacyApi: { getSetting: jest.fn().mockResolvedValue({ error: true }) },
    assistantConfigRequest: jest.fn().mockRejectedValue(new Error('not used in direct mode')),
    serverGetJsonRequest: jest.fn(),
  }
}

let container: HTMLElement
let root: Root
let fetchMock: jest.Mock

beforeEach(() => {
  // jest.config sets resetMocks: true, so implementations belong here.
  for (const key of Object.keys(PREFERENCES)) {
    delete PREFERENCES[key]
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  })

  fetchMock = jest.fn()
  ;(globalThis as { fetch?: unknown }).fetch = fetchMock

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

const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const renderPane = async (preferences: Record<string, unknown>): Promise<string> => {
  const application = makeApplication(preferences)
  await act(async () => {
    root.render(
      createElement(Assistant, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: application as any,
      }),
    )
  })
  await settle()
  return container.textContent ?? ''
}

const findButton = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label) as
    HTMLButtonElement | undefined

const clickCheckCredits = async () => {
  const button = findButton('Check credits')
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

const statusText = (): string => container.querySelector('[data-test-id="direct-credits-status"]')?.textContent ?? ''

const OPENROUTER_PREFS = {
  assistantConnectionMode: 'direct',
  assistantBaseUrl: 'https://openrouter.ai/api/v1',
  assistantApiKey: 'sk-or-v1-browser-held',
  assistantAuthMode: 'api-key',
}

describe('Assistant preferences — Direct-mode remaining credit', () => {
  it('actually renders the credit row and button for OpenRouter', async () => {
    const text = await renderPane(OPENROUTER_PREFS)

    expect(text).toContain('Remaining credit')
    expect(findButton('Check credits')).toBeDefined()
    expect(statusText()).toBe('Not checked yet.')
  })

  it('does not contact anything on render — on demand only', async () => {
    await renderPane(OPENROUTER_PREFS)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains an unsupported endpoint by name, with no button', async () => {
    await renderPane({
      ...OPENROUTER_PREFS,
      assistantBaseUrl: 'https://api.openai.com/v1',
    })

    expect(findButton('Check credits')).toBeUndefined()
    expect(statusText()).toContain('OpenAI does not publish a credit balance')
  })

  it('calls the provider directly with the browser-held key, never our server', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { limit_remaining: 6.5, usage: 3.5 } }),
    })

    await renderPane(OPENROUTER_PREFS)
    await clickCheckCredits()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-browser-held' })

    const status = statusText()
    expect(status).toContain('6.50')
    expect(status).toContain('remaining on OpenRouter')
    expect(status).toContain('checked just now')
  })

  it('renders a rejected key as a specific sentence rather than a blank', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })

    await renderPane(OPENROUTER_PREFS)
    await clickCheckCredits()

    expect(statusText().trim()).not.toBe('')
    expect(statusText()).toContain('OpenRouter rejected the configured API key.')
  })

  // A browser-to-provider call can be refused by CORS. It must land on the plain
  // network failure, with no provider-specific caveat in the interface.
  it('renders a blocked cross-origin call as an ordinary unreachable message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await renderPane({ ...OPENROUTER_PREFS, assistantBaseUrl: 'https://api.deepseek.com/v1' })
    await clickCheckCredits()

    const status = statusText()
    expect(status).toContain('Could not reach DeepSeek.')
    expect(status).not.toMatch(/CORS|cross-origin/i)
  })

  it('reports a missing key as not-configured without any request', async () => {
    await renderPane({ ...OPENROUTER_PREFS, assistantApiKey: '' })
    await clickCheckCredits()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(statusText()).toContain('No API key is configured for OpenRouter')
  })

  it('treats subscription auth mode as unsupported, since Codex publishes no balance', async () => {
    await renderPane({ ...OPENROUTER_PREFS, assistantAuthMode: 'subscription' })

    expect(findButton('Check credits')).toBeUndefined()
    expect(statusText()).toContain('ChatGPT / Codex subscription does not publish a credit balance')
  })

  it('never renders a raw icon token in the credit row', async () => {
    const text = await renderPane(OPENROUTER_PREFS)

    for (const token of ['credit-card', 'coins', 'wallet', 'undefined']) {
      expect(text).not.toContain(token)
    }
  })
})
