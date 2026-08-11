/**
 * @jest-environment jsdom
 */

import { ApplicationEvent, LocalPrefKey, PreferenceServiceInterface } from '@standardnotes/snjs'
import { CustomTheme, CustomThemesState } from './CustomTheme'
import {
  applyCurrentAccountCustomTheme,
  applyCustomThemeFromState,
  applyCustomThemeOverride,
  CUSTOM_THEME_STYLE_ELEMENT_ID,
  handleCustomThemeApplicationEvent,
  LEGACY_CUSTOM_THEMES_STORAGE_KEY,
  loadCustomThemesState,
  migrateLegacyCustomThemes,
  removeCustomThemeOverride,
  saveCustomThemesState,
} from './CustomThemeManager'

const theme: CustomTheme = {
  id: 'custom-theme:test',
  name: 'Test',
  colors: { accent: '#ff0000', background: '#ffffff', foreground: '#000000', contrast: '#eeeeee' },
}

function createPreferences(initial?: CustomThemesState) {
  const values = new Map<LocalPrefKey, unknown>()
  if (initial) {
    values.set(LocalPrefKey.CustomThemes, initial)
  }

  const preferences = {
    getLocalValue: jest.fn((key: LocalPrefKey, fallback?: unknown) => values.get(key) ?? fallback),
    setLocalValue: jest.fn((key: LocalPrefKey, value: unknown) => values.set(key, value)),
  } as unknown as PreferenceServiceInterface

  return { preferences, values }
}

beforeEach(() => {
  localStorage.clear()
  removeCustomThemeOverride()
})

describe('account-local custom theme storage', () => {
  it('round-trips normalized state through the typed local preference', () => {
    const { preferences, values } = createPreferences()
    const state: CustomThemesState = { themes: [theme], selectedId: theme.id }

    saveCustomThemesState(preferences, state)

    expect(values.get(LocalPrefKey.CustomThemes)).toEqual(state)
    expect(loadCustomThemesState(preferences)).toEqual(state)
    expect(localStorage.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)).toBeNull()
  })

  it('drops a selectedId that no longer points to a normalized theme', () => {
    const { preferences } = createPreferences({ themes: [], selectedId: 'custom-theme:gone' })
    expect(loadCustomThemesState(preferences)).toEqual({ themes: [], selectedId: null })
  })

  it('migrates the origin-global legacy value once, persists it, and removes the legacy key', () => {
    const { preferences, values } = createPreferences()
    const legacy: CustomThemesState = { themes: [theme], selectedId: theme.id }
    localStorage.setItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(legacy))

    expect(migrateLegacyCustomThemes(preferences)).toEqual(legacy)
    expect(values.get(LocalPrefKey.CustomThemes)).toEqual(legacy)
    expect(localStorage.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)).toBeNull()

    const replacement = { ...legacy, selectedId: null }
    localStorage.setItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(replacement))
    expect(migrateLegacyCustomThemes(preferences)).toEqual(legacy)
    expect(values.get(LocalPrefKey.CustomThemes)).toEqual(legacy)
    expect(localStorage.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)).toBeNull()
  })

  it('bounds corrupt legacy migration by recording an empty preference and removing the bad value', () => {
    const { preferences, values } = createPreferences()
    localStorage.setItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY, '{ not valid json')

    expect(migrateLegacyCustomThemes(preferences)).toEqual({ themes: [], selectedId: null })
    expect(values.get(LocalPrefKey.CustomThemes)).toEqual({ themes: [], selectedId: null })
    expect(localStorage.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)).toBeNull()
  })

  it('keeps two application preference stores isolated', () => {
    const accountA = createPreferences({ themes: [theme], selectedId: theme.id })
    const accountBTheme: CustomTheme = {
      ...theme,
      id: 'custom-theme:account-b',
      colors: { ...theme.colors, accent: '#00ff00' },
    }
    const accountB = createPreferences({ themes: [accountBTheme], selectedId: accountBTheme.id })

    applyCurrentAccountCustomTheme(accountA.preferences)
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)?.textContent).toContain('#ff0000')

    applyCurrentAccountCustomTheme(accountB.preferences)
    const elements = document.querySelectorAll(`#${CUSTOM_THEME_STYLE_ELEMENT_ID}`)
    expect(elements).toHaveLength(1)
    expect(elements[0].textContent).toContain('#00ff00')
    expect(loadCustomThemesState(accountA.preferences).selectedId).toBe(theme.id)
  })
})

describe('custom theme runtime and application lifecycle', () => {
  it('injects, reorders, and removes the single override element', () => {
    applyCustomThemeOverride(theme)
    const link = document.createElement('link')
    document.head.appendChild(link)
    applyCustomThemeOverride(theme)

    expect(document.head.lastElementChild?.id).toBe(CUSTOM_THEME_STYLE_ELEMENT_ID)
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)?.textContent).toContain(
      '--sn-stylekit-info-color: #ff0000;',
    )

    removeCustomThemeOverride()
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
  })

  it('removes the override for an empty or stale selection', () => {
    applyCustomThemeOverride(theme)
    applyCustomThemeFromState({ themes: [theme], selectedId: null })
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()

    applyCustomThemeOverride(theme)
    applyCustomThemeFromState({ themes: [], selectedId: theme.id })
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
  })

  it('migrates/applies at launch, follows current local preferences, and scrubs on sign-out', () => {
    const { preferences, values } = createPreferences()
    localStorage.setItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify({ themes: [theme], selectedId: theme.id }))

    handleCustomThemeApplicationEvent(preferences, ApplicationEvent.Launched)
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)?.textContent).toContain('#ff0000')

    values.set(LocalPrefKey.CustomThemes, { themes: [theme], selectedId: null })
    handleCustomThemeApplicationEvent(preferences, ApplicationEvent.LocalPreferencesChanged)
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()

    values.set(LocalPrefKey.CustomThemes, { themes: [theme], selectedId: theme.id })
    handleCustomThemeApplicationEvent(preferences, ApplicationEvent.LocalPreferencesChanged)
    handleCustomThemeApplicationEvent(preferences, ApplicationEvent.SignedOut)
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
  })
})
