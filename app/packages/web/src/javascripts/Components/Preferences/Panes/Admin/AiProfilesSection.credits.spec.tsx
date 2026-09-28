/**
 * @jest-environment jsdom
 *
 * AiProfilesSection remaining-credit render guard (MEMORY: verify UI render
 * paths). A green suite and a clean tsc have twice failed to catch admin UI that
 * never appeared on screen, so this drives the REAL component in jsdom and
 * asserts the text an administrator would actually read.
 *
 * The four states are asserted as DISTINCT rendered sentences: a provider that
 * publishes no balance, a profile with no key, a lookup that failed, and a
 * figure (always with its age). Three separate bugs this week rendered a failure
 * as a blank or as a wrong claim; a blank would pass a weaker test than this.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

import AiProfilesSection from './AiProfilesSection'
import { MaskedAiProfile } from './aiProfiles'
import { AdminBackendProfileView } from './adminHelpers'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPENROUTER_PROFILE: MaskedAiProfile = {
  id: 'p-openrouter',
  name: 'OpenRouter',
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-4o-mini',
  enabled: true,
  keyConfigured: true,
}

const ANTHROPIC_PROFILE: MaskedAiProfile = {
  id: 'p-anthropic',
  name: 'Claude',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  enabled: true,
  keyConfigured: true,
}

let container: HTMLElement
let root: Root
let serverGetJsonRequest: jest.Mock

beforeEach(() => {
  // jest.config sets resetMocks: true, so implementations belong here.
  serverGetJsonRequest = jest.fn()
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

const renderSection = async (
  profiles: MaskedAiProfile[],
  backendProfiles: AdminBackendProfileView[] = [],
): Promise<string> => {
  await act(async () => {
    root.render(
      createElement(AiProfilesSection, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        application: { serverGetJsonRequest } as any,
        profiles,
        defaultProfileId: profiles[0]?.id ?? null,
        backendProfiles,
        busy: false,
        onSave: jest.fn().mockResolvedValue(true),
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

const statusText = (profileId: string): string =>
  container.querySelector(`[data-test-id="credits-status-${profileId}"]`)?.textContent ?? ''

describe('AiProfilesSection remaining credit', () => {
  it('actually renders the credit row and its button for a supported provider', async () => {
    const text = await renderSection([OPENROUTER_PROFILE])

    expect(text).toContain('Remaining credit')
    expect(findButton('Check credits')).toBeDefined()
    expect(statusText('p-openrouter')).toBe('Not checked yet.')
  })

  it('does not fetch anything on render — the lookup is on demand only', async () => {
    await renderSection([OPENROUTER_PROFILE])

    expect(serverGetJsonRequest).not.toHaveBeenCalled()
  })

  it('explains an unsupported provider by name, with no button at all', async () => {
    await renderSection([ANTHROPIC_PROFILE])

    expect(findButton('Check credits')).toBeUndefined()
    expect(statusText('p-anthropic')).toContain('Anthropic does not publish a credit balance')
  })

  // The button vanishing with no explanation is what makes a feature look broken.
  it('keeps both profiles distinct when a supported and an unsupported one coexist', async () => {
    await renderSection([OPENROUTER_PROFILE, ANTHROPIC_PROFILE])

    expect(statusText('p-openrouter')).toBe('Not checked yet.')
    expect(statusText('p-anthropic')).toContain('Anthropic does not publish')
    expect(
      [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Check credits'),
    ).toHaveLength(1)
  })

  it('renders the balance together with how old it is', async () => {
    serverGetJsonRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        status: 'ok',
        provider: 'OpenRouter',
        remaining: 8.25,
        usage: 1.75,
        currency: 'USD',
        fetchedAt: new Date().toISOString(),
      },
    })

    await renderSection([OPENROUTER_PROFILE])
    await clickCheckCredits()

    expect(serverGetJsonRequest).toHaveBeenCalledWith('/v1/assistant/credits?profileId=p-openrouter')
    const status = statusText('p-openrouter')
    expect(status).toContain('8.25')
    expect(status).toContain('remaining on OpenRouter')
    expect(status).toContain('checked just now')
  })

  it('explains an uncapped key rather than claiming a zero balance', async () => {
    serverGetJsonRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        status: 'ok',
        provider: 'OpenRouter',
        remaining: null,
        usage: 3.5,
        currency: 'USD',
        note: 'This key has no credit limit set, so no remaining balance is reported.',
        fetchedAt: new Date().toISOString(),
      },
    })

    await renderSection([OPENROUTER_PROFILE])
    await clickCheckCredits()

    const status = statusText('p-openrouter')
    expect(status).toContain('no credit limit set')
    expect(status).toContain('3.50')
    expect(status).not.toContain('$0.00 remaining')
  })

  it('renders a failed lookup as a specific sentence, never as a blank', async () => {
    serverGetJsonRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { status: 'unavailable', provider: 'OpenRouter', reason: 'unauthorized' },
    })

    await renderSection([OPENROUTER_PROFILE])
    await clickCheckCredits()

    const status = statusText('p-openrouter')
    expect(status.trim()).not.toBe('')
    expect(status).toContain('OpenRouter rejected the configured API key.')
  })

  it('survives the request throwing, and still says something specific', async () => {
    serverGetJsonRequest.mockRejectedValue(new Error('boom'))

    await renderSection([OPENROUTER_PROFILE])
    await clickCheckCredits()

    expect(statusText('p-openrouter')).toContain('Could not reach OpenRouter.')
  })

  it('does not trust a malformed server payload', async () => {
    serverGetJsonRequest.mockResolvedValue({ ok: true, status: 200, data: { totally: 'unexpected' } })

    await renderSection([OPENROUTER_PROFILE])
    await clickCheckCredits()

    const status = statusText('p-openrouter')
    expect(status).toContain('unexpected format')
    expect(status).not.toContain('undefined')
    expect(status).not.toContain('NaN')
  })

  it('reports a profile with no key as not-configured rather than as a failure', async () => {
    serverGetJsonRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { status: 'not-configured', provider: 'OpenRouter' },
    })

    await renderSection([{ ...OPENROUTER_PROFILE, keyConfigured: false }])
    await clickCheckCredits()

    const status = statusText('p-openrouter')
    expect(status).toContain('No API key is configured for OpenRouter')
    expect(status).not.toMatch(/failed|rejected|could not reach/i)
  })

  it('follows a referenced backend profile for the capability decision', async () => {
    const viaBackend: MaskedAiProfile = {
      id: 'p-via-backend',
      name: 'Via backend',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      enabled: true,
      keyConfigured: false,
      backendProfileId: 'b-openrouter',
    }
    const backend: AdminBackendProfileView = {
      id: 'b-openrouter',
      name: 'OpenRouter backend',
      type: 'api-key',
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      keyConfigured: true,
    }

    await renderSection([viaBackend], [backend])

    // The profile itself carries no base URL; only the backend identifies OpenRouter.
    expect(findButton('Check credits')).toBeDefined()
    expect(statusText('p-via-backend')).toBe('Not checked yet.')
  })

  // An unmapped Icon name renders as its own literal text, and both tsc and
  // icon-mocking specs are blind to it. This design uses no icon; assert that.
  it('renders no raw icon token in the credit row', async () => {
    const text = await renderSection([OPENROUTER_PROFILE, ANTHROPIC_PROFILE])

    for (const token of ['credit-card', 'coins', 'wallet', 'dollar', 'undefined']) {
      expect(text).not.toContain(token)
    }
  })
})
