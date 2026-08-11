/**
 * @jest-environment jsdom
 */

import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  FeatureStatus,
  LocalPrefKey,
  PreferenceServiceInterface,
  ThemeFeatureDescription,
  UIFeature,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { CustomTheme } from '../Preferences/Panes/Appearance/CustomThemes/CustomTheme'
import {
  applyCustomThemeOverride,
  CUSTOM_THEME_STYLE_ELEMENT_ID,
  loadCustomThemesState,
  removeCustomThemeOverride,
} from '../Preferences/Panes/Appearance/CustomThemes/CustomThemeManager'

let mockApplication: WebApplication

jest.mock('../ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('../KeyboardServiceProvider', () => ({
  useKeyboardService: () => ({ keyboardShortcutForCommand: jest.fn(() => undefined) }),
}))
jest.mock('@/Hooks/usePremiumModal', () => ({ usePremiumModal: () => ({ activate: jest.fn() }) }))
jest.mock('@/Utils', () => ({ isMobileScreen: () => false }))
jest.mock('../Menu/MenuRadioButtonItem', () => ({
  __esModule: true,
  default: ({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) =>
    createElement('button', { type: 'button', role: 'radio', 'aria-checked': checked, onClick }, children),
}))
jest.mock('../Menu/MenuSwitchButtonItem', () => ({
  __esModule: true,
  default: ({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) =>
    createElement('button', { type: 'button', role: 'checkbox', 'aria-checked': checked, onClick: onChange }, children),
}))

import ThemesMenuButton from './ThemesMenuButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const customTheme: CustomTheme = {
  id: 'custom-theme:quick-settings',
  name: 'Quick custom',
  colors: { accent: '#654321', background: '#fff', foreground: '#111', contrast: '#eee' },
}

function fakeTheme(layerable = false): UIFeature<ThemeFeatureDescription> {
  return {
    displayName: layerable ? 'Overlay' : 'Ocean',
    featureIdentifier: layerable ? 'theme-overlay' : 'theme-ocean',
    uniqueIdentifier: { value: layerable ? 'theme-overlay' : 'theme-ocean' },
    layerable,
    dockIcon: {
      type: 'circle',
      background_color: '#123456',
      foreground_color: '#ffffff',
      border_color: '#123456',
    },
  } as unknown as UIFeature<ThemeFeatureDescription>
}

function configureApplication(theme: UIFeature<ThemeFeatureDescription>, active = false) {
  const values = new Map<LocalPrefKey, unknown>([
    [LocalPrefKey.CustomThemes, { themes: [customTheme], selectedId: customTheme.id }],
  ])
  const preferences = {
    getLocalValue: jest.fn((key: LocalPrefKey, fallback?: unknown) => values.get(key) ?? fallback),
    setLocalValue: jest.fn((key: LocalPrefKey, value: unknown) => values.set(key, value)),
  } as unknown as PreferenceServiceInterface
  const selectTheme = jest.fn(async () => undefined)
  mockApplication = {
    preferences,
    features: {
      isThirdPartyFeature: jest.fn(() => false),
      getFeatureStatus: jest.fn(() => FeatureStatus.Entitled),
    },
    componentManager: { isThemeActive: jest.fn(() => active) },
    themeManager: { selectTheme, setColorSchemeMode: jest.fn() },
    isNativeMobileWeb: jest.fn(() => false),
  } as unknown as WebApplication
  return { preferences, selectTheme }
}

describe('ThemesMenuButton custom/built-in ownership', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    removeCustomThemeOverride()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('shows no base-theme radio selected while a custom theme is active', () => {
    const theme = fakeTheme()
    configureApplication(theme, true)
    act(() => root.render(createElement(ThemesMenuButton, { uiFeature: theme, customThemeActive: true })))
    expect(container.querySelector('[role="radio"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('reveals an already-active base theme instead of toggling it off', async () => {
    const theme = fakeTheme()
    const harness = configureApplication(theme, true)
    act(() => root.render(createElement(ThemesMenuButton, { uiFeature: theme, customThemeActive: true })))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="radio"]')?.click()
      await Promise.resolve()
    })

    expect(loadCustomThemesState(harness.preferences).selectedId).toBeNull()
    expect(harness.selectTheme).not.toHaveBeenCalled()
  })

  it('clears and persists the custom override before selecting a base theme', async () => {
    const theme = fakeTheme()
    const harness = configureApplication(theme)
    applyCustomThemeOverride(customTheme)
    act(() => root.render(createElement(ThemesMenuButton, { uiFeature: theme, customThemeActive: true })))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="radio"]')?.click()
      await Promise.resolve()
    })

    expect(loadCustomThemesState(harness.preferences).selectedId).toBeNull()
    expect(document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)).toBeNull()
    expect(harness.selectTheme).toHaveBeenCalledWith(theme)
  })

  it('keeps custom ownership when toggling an independent layerable overlay', async () => {
    const overlay = fakeTheme(true)
    const harness = configureApplication(overlay)
    act(() => root.render(createElement(ThemesMenuButton, { uiFeature: overlay, customThemeActive: true })))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
      await Promise.resolve()
    })

    expect(loadCustomThemesState(harness.preferences).selectedId).toBe(customTheme.id)
    expect(harness.selectTheme).toHaveBeenCalledWith(overlay)
  })
})
