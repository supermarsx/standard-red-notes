/**
 * @jest-environment jsdom
 */

import {
  FindNativeTheme,
  LocalPrefKey,
  NativeFeatureIdentifier,
  PreferenceServiceInterface,
  ThemeFeatureDescription,
  UIFeature,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { CustomTheme, CustomThemesState } from './CustomThemes/CustomTheme'
import {
  applyCurrentAccountCustomTheme,
  CUSTOM_THEME_STYLE_ELEMENT_ID,
  loadCustomThemesState,
  removeCustomThemeOverride,
  saveCustomThemesState,
} from './CustomThemes/CustomThemeManager'
import { selectBuiltInTheme, selectCustomTheme } from './ThemeSelection'

const customTheme: CustomTheme = {
  id: 'custom-theme:selection-test',
  name: 'Selection test',
  colors: { accent: '#123456', background: '#ffffff', foreground: '#111111', contrast: '#eeeeee' },
}

function createHarness(initial: CustomThemesState = { themes: [], selectedId: null }) {
  const values = new Map<LocalPrefKey, unknown>([[LocalPrefKey.CustomThemes, initial]])
  const preferences = {
    getLocalValue: jest.fn((key: LocalPrefKey, fallback?: unknown) => values.get(key) ?? fallback),
    setLocalValue: jest.fn((key: LocalPrefKey, value: unknown) => values.set(key, value)),
  } as unknown as PreferenceServiceInterface
  const themeManager = {
    setColorSchemeMode: jest.fn(),
    selectTheme: jest.fn(async () => undefined),
    selectDefaultTheme: jest.fn(async () => undefined),
  }
  const application = { preferences, themeManager } as unknown as WebApplication
  Object.assign(application, { componentManager: { isThemeActive: jest.fn(() => false) } })
  return { application, preferences, themeManager, values }
}

function darkTheme(): UIFeature<ThemeFeatureDescription> {
  const feature = FindNativeTheme(NativeFeatureIdentifier.TYPES.DarkTheme)
  if (!feature) {
    throw new Error('Dark theme fixture is missing')
  }
  return new UIFeature(feature)
}

beforeEach(() => {
  removeCustomThemeOverride()
})

it('clears and persists a custom selection before selecting a built-in theme', async () => {
  const harness = createHarness({ themes: [customTheme], selectedId: customTheme.id })
  applyCurrentAccountCustomTheme(harness.preferences)
  expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).not.toBeNull()

  const builtIn = darkTheme()
  await selectBuiltInTheme(harness.application, builtIn)

  expect(loadCustomThemesState(harness.preferences).selectedId).toBeNull()
  expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
  expect(harness.themeManager.selectTheme).toHaveBeenCalledWith(builtIn)

  // Recreate a preference service from the persisted value: reload must not
  // resurrect the custom override.
  const reloaded = createHarness(harness.values.get(LocalPrefKey.CustomThemes) as CustomThemesState)
  applyCurrentAccountCustomTheme(reloaded.preferences)
  expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
})

it('clears a custom selection before selecting Standard Red', async () => {
  const harness = createHarness({ themes: [customTheme], selectedId: customTheme.id })
  saveCustomThemesState(harness.preferences, { themes: [customTheme], selectedId: customTheme.id })

  await selectBuiltInTheme(harness.application)

  expect(loadCustomThemesState(harness.preferences).selectedId).toBeNull()
  expect(harness.themeManager.selectDefaultTheme).toHaveBeenCalledTimes(1)
})

it('reveals an already-active built-in without toggling it off', async () => {
  const harness = createHarness({ themes: [customTheme], selectedId: customTheme.id })
  const builtIn = darkTheme()
  jest.mocked(harness.application.componentManager.isThemeActive).mockReturnValue(true)

  await selectBuiltInTheme(harness.application, builtIn)

  expect(loadCustomThemesState(harness.preferences).selectedId).toBeNull()
  expect(harness.themeManager.setColorSchemeMode).toHaveBeenCalledWith('manual')
  expect(harness.themeManager.selectTheme).not.toHaveBeenCalled()
})

it('selects a saved custom theme locally and gives Manual mode ownership', () => {
  const harness = createHarness({ themes: [customTheme], selectedId: null })

  expect(selectCustomTheme(harness.application, customTheme.id)).toBe(true)

  expect(harness.themeManager.setColorSchemeMode).toHaveBeenCalledWith('manual')
  expect(loadCustomThemesState(harness.preferences).selectedId).toBe(customTheme.id)
  expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)?.textContent).toContain('#123456')
})

it('refuses an unknown custom id without changing preferences or mode', () => {
  const harness = createHarness({ themes: [customTheme], selectedId: null })

  expect(selectCustomTheme(harness.application, 'custom-theme:missing')).toBe(false)
  expect(harness.themeManager.setColorSchemeMode).not.toHaveBeenCalled()
  expect(harness.preferences.setLocalValue).not.toHaveBeenCalled()
})
