import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  DEFAULT_SELECTION_ACTIONS,
  getSelectionActions,
  getSelectionAIAvailability,
  SelectionActionId,
} from './selectionActions'

type Prefs = Partial<Record<string, unknown>>

/**
 * Build a minimal fake `application` that only implements the two methods the
 * functions under test depend on: getPreference(key, default) and hasAccount().
 * We deliberately do NOT instantiate the real WebApplication.
 */
function fakeApplication(prefs: Prefs = {}, hasAccount = false): WebApplication {
  return {
    getPreference: (key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : defaultValue,
    hasAccount: () => hasAccount,
  } as unknown as WebApplication
}

describe('getSelectionActions', () => {
  it('returns the built-in defaults when there is no override preference', () => {
    const actions = getSelectionActions(fakeApplication())
    expect(actions).toEqual(DEFAULT_SELECTION_ACTIONS)
  })

  it('returns defaults when the override preference is an empty string', () => {
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: '' }))
    expect(actions).toEqual(DEFAULT_SELECTION_ACTIONS)
  })

  it('does not mutate the shared DEFAULT_SELECTION_ACTIONS array', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_SELECTION_ACTIONS))
    getSelectionActions(
      fakeApplication({
        [PrefKey.AssistantSelectionActions]: JSON.stringify({ refine: { enabled: false } }),
      }),
    )
    expect(DEFAULT_SELECTION_ACTIONS).toEqual(before)
  })

  it('merges a user override (enabled + prompt) from a JSON string preference', () => {
    const overrides: Partial<Record<SelectionActionId, { enabled?: boolean; prompt?: string }>> = {
      refine: { enabled: false, prompt: 'Custom refine prompt.' },
      summarize: { prompt: 'My summary instruction.' },
    }
    const actions = getSelectionActions(
      fakeApplication({ [PrefKey.AssistantSelectionActions]: JSON.stringify(overrides) }),
    )

    const refine = actions.find((a) => a.id === 'refine')!
    expect(refine.enabled).toBe(false)
    expect(refine.prompt).toBe('Custom refine prompt.')

    const summarize = actions.find((a) => a.id === 'summarize')!
    // enabled not overridden -> keeps default of true
    expect(summarize.enabled).toBe(true)
    expect(summarize.prompt).toBe('My summary instruction.')

    // Untouched actions keep their defaults.
    const expand = actions.find((a) => a.id === 'expand')!
    const defaultExpand = DEFAULT_SELECTION_ACTIONS.find((a) => a.id === 'expand')!
    expect(expand).toEqual(defaultExpand)
  })

  it('falls back to defaults when the override preference is malformed JSON', () => {
    const actions = getSelectionActions(
      fakeApplication({ [PrefKey.AssistantSelectionActions]: '{ not valid json ]' }),
    )
    expect(actions).toEqual(DEFAULT_SELECTION_ACTIONS)
  })

  it('keeps non-static action fields (label, icon, freeform) from defaults after merge', () => {
    const actions = getSelectionActions(
      fakeApplication({
        [PrefKey.AssistantSelectionActions]: JSON.stringify({ ask: { prompt: 'overridden' } }),
      }),
    )
    const ask = actions.find((a) => a.id === 'ask')!
    expect(ask.label).toBe('Ask AI…')
    expect(ask.icon).toBe('dashboard')
    expect(ask.freeform).toBe(true)
    expect(ask.prompt).toBe('overridden')
  })
})

describe('getSelectionAIAvailability', () => {
  describe('direct mode (default)', () => {
    it('is available when both baseURL and model are configured', () => {
      const app = fakeApplication({
        [PrefKey.AssistantConnectionMode]: 'direct',
        [PrefKey.AssistantBaseUrl]: 'http://localhost:1234/v1',
        [PrefKey.AssistantModel]: 'gpt-test',
      })
      expect(getSelectionAIAvailability(app)).toEqual({ available: true })
    })

    it('defaults to direct mode when no connection mode preference is set', () => {
      const app = fakeApplication({
        [PrefKey.AssistantBaseUrl]: 'http://localhost:1234/v1',
        [PrefKey.AssistantModel]: 'gpt-test',
      })
      expect(getSelectionAIAvailability(app)).toEqual({ available: true })
    })

    it('is unavailable when baseURL is missing', () => {
      const app = fakeApplication({
        [PrefKey.AssistantConnectionMode]: 'direct',
        [PrefKey.AssistantModel]: 'gpt-test',
      })
      const result = getSelectionAIAvailability(app)
      expect(result.available).toBe(false)
      expect(result.reason).toBe('Configure the AI endpoint and model in Preferences → Assistant.')
    })

    it('is unavailable when model is missing', () => {
      const app = fakeApplication({
        [PrefKey.AssistantConnectionMode]: 'direct',
        [PrefKey.AssistantBaseUrl]: 'http://localhost:1234/v1',
      })
      const result = getSelectionAIAvailability(app)
      expect(result.available).toBe(false)
      expect(result.reason).toBe('Configure the AI endpoint and model in Preferences → Assistant.')
    })
  })

  describe('proxy mode', () => {
    it('is unavailable without an account and asks the user to sign in', () => {
      const app = fakeApplication(
        {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: 'openai',
        },
        false,
      )
      const result = getSelectionAIAvailability(app)
      expect(result.available).toBe(false)
      expect(result.reason).toBe('Sign in to use the AI assistant.')
    })

    it('is unavailable with an account but no provider chosen', () => {
      const app = fakeApplication(
        {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: '',
        },
        true,
      )
      const result = getSelectionAIAvailability(app)
      expect(result.available).toBe(false)
      expect(result.reason).toBe('Choose an AI provider in Preferences → Assistant.')
    })

    it('is available with an account and a provider configured', () => {
      const app = fakeApplication(
        {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: 'openai',
        },
        true,
      )
      expect(getSelectionAIAvailability(app)).toEqual({ available: true })
    })
  })
})
