import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  buildAssistantProvider,
  buildTranslateInstruction,
  createCustomSelectionAction,
  CUSTOM_ACTION_ID_PREFIX,
  DEFAULT_SELECTION_ACTIONS,
  getSelectionActions,
  getSelectionAIAvailability,
  MAX_CUSTOM_SELECTION_ACTIONS,
  MAX_SELECTION_ACTION_PROMPT_CHARS,
  resolveActiveProfileOverrides,
  SelectionAction,
  SelectionActionId,
  serializeSelectionActions,
} from './selectionActions'
import { DirectProvider, DirectProviderOptions } from './DirectProvider'
import { getPersona, savePersonaProfiles, savePersonaSettings } from './personaSettings'
import { DEFAULT_SAMPLING_SETTINGS, samplingRequestFields, saveSamplingSettings } from './samplingSettings'

type Prefs = Partial<Record<string, unknown>>

/**
 * Build a minimal fake `application` that only implements the two methods the
 * functions under test depend on: getPreference(key, default) and hasAccount().
 * We deliberately do NOT instantiate the real WebApplication.
 */
function fakeApplication(
  prefs: Prefs = {},
  hasAccount = false,
  userUuid = hasAccount ? 'account-default' : undefined,
  identifier = 'anonymous-workspace',
): WebApplication {
  return {
    identifier,
    getPreference: (key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : defaultValue,
    hasAccount: () => hasAccount,
    sessions: {
      isSignedIn: () => hasAccount,
      getUser: () => (userUuid ? { uuid: userUuid } : undefined),
    },
  } as unknown as WebApplication
}

beforeEach(() => {
  localStorage.clear()
})

describe('getSelectionActions', () => {
  it('ships the requested ribbon groups in stable action order', () => {
    const inGroup = (group: SelectionAction['group']) =>
      DEFAULT_SELECTION_ACTIONS.filter((action) => action.group === group)
    expect(inGroup('text-review').map((action) => action.id)).toEqual(['refine', 'expand', 'summarize'])
    expect(inGroup('transforms').map((action) => action.id)).toEqual(['translate', 'organize'])
    expect(inGroup('assistant').map((action) => action.id)).toEqual(['ask', 'explain'])
    expect(inGroup('assistant').every((action) => action.behavior === 'chat')).toBe(true)
    expect([...inGroup('text-review'), ...inGroup('transforms')].every((action) => action.behavior === 'replace')).toBe(
      true,
    )
  })

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
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: '{ not valid json ]' }))
    expect(actions).toEqual(DEFAULT_SELECTION_ACTIONS)
  })

  it('rejects malformed synced override types instead of sending a non-string chat directive', () => {
    const actions = getSelectionActions(
      fakeApplication({
        [PrefKey.AssistantSelectionActions]: JSON.stringify({
          overrides: {
            explain: { prompt: null, enabled: 'yes' },
            refine: { prompt: { injected: true }, enabled: 1 },
          },
        }),
      }),
    )

    expect(actions.find((action) => action.id === 'explain')).toEqual(
      DEFAULT_SELECTION_ACTIONS.find((action) => action.id === 'explain'),
    )
    expect(actions.find((action) => action.id === 'refine')).toEqual(
      DEFAULT_SELECTION_ACTIONS.find((action) => action.id === 'refine'),
    )
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

describe('custom selection actions', () => {
  it('accepts the legacy bare-override pref shape (back-compat)', () => {
    const actions = getSelectionActions(
      fakeApplication({
        [PrefKey.AssistantSelectionActions]: JSON.stringify({ refine: { enabled: false } }),
      }),
    )
    expect(actions.find((a) => a.id === 'refine')!.enabled).toBe(false)
    // No custom actions in the legacy shape.
    expect(actions.filter((a) => a.custom)).toHaveLength(0)
  })

  it('appends custom actions after the built-ins from the new pref shape', () => {
    const pref = {
      overrides: { summarize: { prompt: 'Short summary.' } },
      custom: [{ id: `${CUSTOM_ACTION_ID_PREFIX}1`, label: 'Bulletize', prompt: 'Turn into bullets.', enabled: true }],
    }
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: JSON.stringify(pref) }))
    expect(actions.find((a) => a.id === 'summarize')!.prompt).toBe('Short summary.')
    const custom = actions.find((a) => a.id === `${CUSTOM_ACTION_ID_PREFIX}1`)!
    expect(custom).toBeDefined()
    expect(custom.custom).toBe(true)
    expect(custom.label).toBe('Bulletize')
    expect(custom.prompt).toBe('Turn into bullets.')
    // Custom actions come after every built-in.
    expect(actions.indexOf(custom)).toBeGreaterThanOrEqual(DEFAULT_SELECTION_ACTIONS.length)
  })

  it('drops custom records whose id is missing, unprefixed, or shadows a built-in', () => {
    const pref = {
      custom: [
        { id: '', label: 'No id', prompt: 'x' },
        { id: 'unprefixed', label: 'Bad id', prompt: 'x' },
        { id: 'refine', label: 'Shadows built-in', prompt: 'x' },
        { id: `${CUSTOM_ACTION_ID_PREFIX}ok`, label: 'Good', prompt: 'x' },
      ],
    }
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: JSON.stringify(pref) }))
    const customs = actions.filter((a) => a.custom)
    expect(customs).toHaveLength(1)
    expect(customs[0].id).toBe(`${CUSTOM_ACTION_ID_PREFIX}ok`)
    // The built-in refine is untouched (not replaced by the shadowing record).
    expect(actions.find((a) => a.id === 'refine')!.label).toBe('Refine')
  })

  it('defaults missing custom fields (icon/enabled/needsLanguage)', () => {
    const pref = { custom: [{ id: `${CUSTOM_ACTION_ID_PREFIX}1`, label: 'X', prompt: 'do x' }] }
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: JSON.stringify(pref) }))
    const custom = actions.find((a) => a.id === `${CUSTOM_ACTION_ID_PREFIX}1`)!
    expect(custom.icon).toBe('dashboard')
    expect(custom.enabled).toBe(true)
    expect(custom.needsLanguage).toBe(false)
    expect(custom.group).toBe('transforms')
    expect(custom.behavior).toBe('replace')
  })

  it('bounds and validates untrusted custom action metadata', () => {
    const valid = Array.from({ length: MAX_CUSTOM_SELECTION_ACTIONS + 10 }, (_, index) => ({
      id: `${CUSTOM_ACTION_ID_PREFIX}action-${index}`,
      label: `Action ${index}`,
      prompt: 'Safe prompt',
    }))
    const pref = {
      custom: [
        { id: `${CUSTOM_ACTION_ID_PREFIX}null-prompt`, label: 'Bad', prompt: null },
        { id: `${CUSTOM_ACTION_ID_PREFIX}bad/icon`, label: 'Bad', prompt: 'x', icon: '../script' },
        ...valid,
      ],
    }
    const actions = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: JSON.stringify(pref) }))
    const customs = actions.filter((action) => action.custom)

    expect(customs.length).toBeLessThanOrEqual(MAX_CUSTOM_SELECTION_ACTIONS)
    expect(customs.some((action) => action.id.includes('null-prompt'))).toBe(false)
    expect(customs.some((action) => action.id.includes('bad/icon'))).toBe(false)

    const oversizedOverride = JSON.stringify({
      overrides: { explain: { prompt: 'x'.repeat(MAX_SELECTION_ACTION_PROMPT_CHARS + 1) } },
    })
    expect(
      getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: oversizedOverride })).find(
        (action) => action.id === 'explain',
      )?.prompt,
    ).toBe(DEFAULT_SELECTION_ACTIONS.find((action) => action.id === 'explain')?.prompt)
  })

  it('createCustomSelectionAction makes a prefixed, unique, enabled action', () => {
    const existing: SelectionAction[] = [...DEFAULT_SELECTION_ACTIONS]
    const created = createCustomSelectionAction(existing)
    expect(created.custom).toBe(true)
    expect(created.enabled).toBe(true)
    expect(created.id.startsWith(CUSTOM_ACTION_ID_PREFIX)).toBe(true)
    expect(existing.some((a) => a.id === created.id)).toBe(false)
  })

  it('serializeSelectionActions splits built-in overrides from custom records and round-trips', () => {
    const base = getSelectionActions(fakeApplication())
    const edited: SelectionAction[] = base.map((a) =>
      a.id === 'refine' ? { ...a, enabled: false, prompt: 'Edited refine.' } : a,
    )
    const custom = createCustomSelectionAction(edited)
    custom.label = 'My action'
    custom.prompt = 'Translate into {language}.'
    custom.needsLanguage = true
    const all = [...edited, custom]

    const serialized = serializeSelectionActions(all)
    const parsed = JSON.parse(serialized)
    expect(parsed.overrides.refine).toEqual({ enabled: false, prompt: 'Edited refine.' })
    expect(parsed.custom).toHaveLength(1)
    expect(parsed.custom[0].id).toBe(custom.id)

    // Feeding the serialized pref back yields the same effective actions.
    const reloaded = getSelectionActions(fakeApplication({ [PrefKey.AssistantSelectionActions]: serialized }))
    expect(reloaded.find((a) => a.id === 'refine')!.prompt).toBe('Edited refine.')
    const reloadedCustom = reloaded.find((a) => a.id === custom.id)!
    expect(reloadedCustom.label).toBe('My action')
    expect(reloadedCustom.needsLanguage).toBe(true)
    expect(reloadedCustom.group).toBe('transforms')
    expect(reloadedCustom.behavior).toBe('replace')
  })
})

describe('translate selection action', () => {
  it('ships a translate action that needs a language and carries a {language} placeholder', () => {
    const translate = DEFAULT_SELECTION_ACTIONS.find((a) => a.id === 'translate')!
    expect(translate).toBeDefined()
    expect(translate.needsLanguage).toBe(true)
    expect(translate.prompt).toContain('{language}')
  })

  it('substitutes the chosen language into the {language} placeholder', () => {
    const result = buildTranslateInstruction('Translate into {language}. Reply with only the translation.', 'French')
    expect(result).toBe('Translate into French. Reply with only the translation.')
    expect(result).not.toContain('{language}')
  })

  it('replaces every occurrence of the placeholder', () => {
    expect(buildTranslateInstruction('{language} text in {language}', 'German')).toBe('German text in German')
  })

  it('appends the language when a user-edited template omits the placeholder', () => {
    expect(buildTranslateInstruction('Translate this text.', 'Spanish')).toBe(
      'Translate this text. Target language: Spanish.',
    )
  })

  it('trims surrounding whitespace from the chosen language', () => {
    expect(buildTranslateInstruction('Into {language}.', '  Japanese  ')).toBe('Into Japanese.')
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

    it('uses automatic server profile resolution when no provider is chosen', () => {
      const app = fakeApplication(
        {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: '',
        },
        true,
      )
      expect(getSelectionAIAvailability(app)).toEqual({ available: true })
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

describe('account-scoped active profile resolution', () => {
  it('never lets account A profile endpoint, model, sampling, or persona affect account B', () => {
    savePersonaProfiles('account:account-a', {
      activeId: 'profile-a',
      profiles: [
        {
          id: 'profile-a',
          name: 'Account A',
          persona: 'Account A private persona.',
          model: 'model-a-profile',
          baseURL: 'https://account-a.invalid/v1',
          temperature: 1.9,
          topP: 0.2,
          maxTokens: 999,
          useServerTemperature: false,
          useServerTopP: false,
        },
      ],
    })
    saveSamplingSettings('account:account-a', {
      ...DEFAULT_SAMPLING_SETTINGS,
      temperature: 1.5,
      useServerTemperature: false,
    })
    savePersonaSettings('account:account-b', { persona: 'Account B scoped persona.' })

    const applicationA = fakeApplication(
      {
        [PrefKey.AssistantConnectionMode]: 'direct',
        [PrefKey.AssistantBaseUrl]: 'https://account-a-global.invalid/v1',
        [PrefKey.AssistantModel]: 'model-a-global',
      },
      true,
      'account-a',
    )
    expect(resolveActiveProfileOverrides(applicationA)).toMatchObject({
      baseURL: 'https://account-a.invalid/v1',
      model: 'model-a-profile',
      sampling: {
        temperature: 1.9,
        topP: 0.2,
        maxTokens: 999,
        useServerTemperature: false,
        useServerTopP: false,
      },
    })

    const applicationB = fakeApplication(
      {
        [PrefKey.AssistantConnectionMode]: 'direct',
        [PrefKey.AssistantBaseUrl]: 'https://account-b.example/v1',
        [PrefKey.AssistantModel]: 'model-b-synced',
      },
      true,
      'account-b',
    )

    expect(resolveActiveProfileOverrides(applicationB)).toEqual({
      baseURL: 'https://account-b.example/v1',
      model: 'model-b-synced',
      sampling: DEFAULT_SAMPLING_SETTINGS,
    })
    expect(getPersona('account:account-b')).toBe('Account B scoped persona.')

    const provider = buildAssistantProvider(applicationB)
    expect(provider).toBeInstanceOf(DirectProvider)
    expect((provider as unknown as { options: DirectProviderOptions }).options).toMatchObject({
      baseURL: 'https://account-b.example/v1',
      model: 'model-b-synced',
      sampling: DEFAULT_SAMPLING_SETTINGS,
    })
  })

  it('keeps a fresh persona profile on provider-owned temperature and top-p defaults', () => {
    savePersonaProfiles('account:account-a', {
      activeId: 'persona-only',
      profiles: [
        {
          id: 'persona-only',
          name: 'Persona only',
          persona: 'Be concise.',
          model: '',
          baseURL: '',
          temperature: 0.7,
          topP: 1,
          maxTokens: 0,
          useServerTemperature: true,
          useServerTopP: true,
        },
      ],
    })
    const application = fakeApplication(
      {
        [PrefKey.AssistantBaseUrl]: 'https://account-a.example/v1',
        [PrefKey.AssistantModel]: 'model-a',
      },
      true,
      'account-a',
    )

    expect(samplingRequestFields(resolveActiveProfileOverrides(application).sampling)).toEqual({})
  })
})
