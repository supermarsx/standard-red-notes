import {
  composeSystemPromptWithPersona,
  createPersonaProfile,
  DEFAULT_PERSONA_PROFILES_STATE,
  getActiveProfile,
  getAssistantAccountScope,
  getPersona,
  loadPersonaProfiles,
  normalizePersonaProfilesState,
  PERSONA_MAX_LENGTH,
  PersonaProfile,
  savePersonaProfiles,
  savePersonaSettings,
} from './personaSettings'

beforeEach(() => {
  localStorage.clear()
})

const SCOPE_A = 'account:account-a'
const SCOPE_B = 'account:account-b'

const baseProfile = (over: Partial<PersonaProfile> = {}): PersonaProfile => ({
  id: 'p1',
  name: 'Coding',
  persona: 'A concise senior engineer.',
  model: 'gpt-test',
  baseURL: 'http://localhost:1234/v1',
  temperature: 0.3,
  topP: 0.9,
  maxTokens: 1000,
  useServerTemperature: true,
  useServerTopP: true,
  ...over,
})

describe('persona profiles normalization', () => {
  it('returns the empty default for null/garbage input', () => {
    expect(normalizePersonaProfilesState(null)).toEqual(DEFAULT_PERSONA_PROFILES_STATE)
    expect(normalizePersonaProfilesState(undefined)).toEqual(DEFAULT_PERSONA_PROFILES_STATE)
  })

  it('drops profiles without an id and de-dupes by id', () => {
    const state = normalizePersonaProfilesState({
      activeId: 'p1',
      profiles: [
        baseProfile(),
        baseProfile({ name: 'Dup' }), // same id p1 -> dropped
        { name: 'No id', persona: 'x' } as PersonaProfile, // no id -> dropped
        baseProfile({ id: 'p2', name: 'Creative' }),
      ],
    })
    expect(state.profiles.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(state.profiles[0].name).toBe('Coding')
  })

  it('clamps per-profile sampling params', () => {
    const state = normalizePersonaProfilesState({
      activeId: 'p1',
      profiles: [baseProfile({ temperature: 99, topP: -1, maxTokens: -5 })],
    })
    expect(state.profiles[0].temperature).toBe(2)
    expect(state.profiles[0].topP).toBe(0)
    expect(state.profiles[0].maxTokens).toBe(0)
  })

  it('falls back activeId to the first profile when it references nothing', () => {
    const state = normalizePersonaProfilesState({
      activeId: 'missing',
      profiles: [baseProfile({ id: 'a' }), baseProfile({ id: 'b' })],
    })
    expect(state.activeId).toBe('a')
  })

  it('caps persona length to PERSONA_MAX_LENGTH', () => {
    const long = 'x'.repeat(PERSONA_MAX_LENGTH + 50)
    const state = normalizePersonaProfilesState({ activeId: 'p1', profiles: [baseProfile({ persona: long })] })
    expect(state.profiles[0].persona.length).toBe(PERSONA_MAX_LENGTH)
  })
})

describe('persona profiles load/save + active selection', () => {
  it('round-trips through localStorage', () => {
    savePersonaProfiles(SCOPE_A, {
      activeId: 'p2',
      profiles: [baseProfile(), baseProfile({ id: 'p2', name: 'Creative' })],
    })
    const loaded = loadPersonaProfiles(SCOPE_A)
    expect(loaded.activeId).toBe('p2')
    expect(loaded.profiles).toHaveLength(2)
    expect(getActiveProfile(SCOPE_A)!.id).toBe('p2')
  })

  it('getActiveProfile is undefined when no profiles exist', () => {
    expect(getActiveProfile(SCOPE_A)).toBeUndefined()
  })

  it('does not load another account profile or unattributable unscoped storage', () => {
    savePersonaProfiles(SCOPE_A, { activeId: 'p1', profiles: [baseProfile()] })
    localStorage.setItem(
      'standardnotes.assistantPersonaProfiles.settings.v1',
      JSON.stringify({ activeId: 'legacy', profiles: [baseProfile({ id: 'legacy' })] }),
    )

    expect(loadPersonaProfiles(SCOPE_B)).toEqual(DEFAULT_PERSONA_PROFILES_STATE)
    expect(getActiveProfile(SCOPE_B)).toBeUndefined()
  })

  it('createPersonaProfile produces a unique id not already used', () => {
    const existing = [baseProfile()]
    const created = createPersonaProfile(existing)
    expect(existing.some((p) => p.id === created.id)).toBe(false)
    expect(created.persona).toBe('')
  })
})

describe('getPersona honors the active profile', () => {
  it('uses the single persona when no profiles exist', () => {
    savePersonaSettings(SCOPE_A, { persona: 'single persona' })
    expect(getPersona(SCOPE_A)).toBe('single persona')
  })

  it('prefers the active profile persona over the single persona', () => {
    savePersonaSettings(SCOPE_A, { persona: 'single persona' })
    savePersonaProfiles(SCOPE_A, { activeId: 'p1', profiles: [baseProfile({ persona: 'profile persona' })] })
    expect(getPersona(SCOPE_A)).toBe('profile persona')
  })

  it('feeds the active profile persona into composeSystemPromptWithPersona', () => {
    savePersonaProfiles(SCOPE_A, { activeId: 'p1', profiles: [baseProfile({ persona: 'profile persona' })] })
    const composed = composeSystemPromptWithPersona('BASE', getPersona(SCOPE_A))
    expect(composed).toContain('BASE')
    expect(composed).toContain('profile persona')
  })

  it('does not apply account A persona to account B', () => {
    savePersonaSettings(SCOPE_A, { persona: 'account A secret style' })
    expect(getPersona(SCOPE_B)).toBe('')
  })
})

describe('assistant account scope', () => {
  it('uses the signed-in user UUID instead of the application identifier', () => {
    expect(
      getAssistantAccountScope({
        identifier: 'workspace',
        sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'user-a' }) },
      } as never),
    ).toBe('account:user-a')
  })

  it('uses the application identifier for an anonymous workspace', () => {
    expect(
      getAssistantAccountScope({
        identifier: 'anonymous-workspace',
        sessions: { isSignedIn: () => false, getUser: () => undefined },
      } as never),
    ).toBe('application:anonymous-workspace')
  })

  it('fails closed when a signed-in user UUID is unavailable', () => {
    expect(
      getAssistantAccountScope({
        identifier: 'workspace',
        sessions: { isSignedIn: () => true, getUser: () => undefined },
      } as never),
    ).toBeUndefined()
  })
})
