/**
 * @jest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  FeatureStatus,
  LocalPrefKey,
  PreferencesServiceEvent,
  ThemeFeatureDescription,
  UIFeature,
} from '@standardnotes/snjs'
import { NativeFeatureIdentifier } from '@standardnotes/features'
import { WebApplication } from '@/Application/WebApplication'
import { CustomThemesState } from './CustomThemes/CustomTheme'

const mockPremiumActivate = jest.fn()

jest.mock('@/Hooks/usePremiumModal', () => ({
  usePremiumModal: () => ({ activate: mockPremiumActivate }),
}))

import BaseThemePalette from './BaseThemePalette'
import { STANDARD_RED_SWATCH } from './ThemeSelection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeTheme = UIFeature<ThemeFeatureDescription>

function fakeTheme(id: string, name: string, color?: string): FakeTheme {
  return {
    displayName: name,
    featureIdentifier: id,
    uniqueIdentifier: { value: id },
    layerable: false,
    dockIcon: color
      ? { type: 'circle', background_color: color, foreground_color: '#ffffff', border_color: color }
      : undefined,
  } as unknown as FakeTheme
}

function createApplication(
  initialThemes: FakeTheme[],
  initialActiveId?: string,
  customSelectedId: string | null = null,
) {
  let activeId = initialActiveId
  let themeStreamObserver: (() => void) | undefined
  let preferenceObserver: ((event: PreferencesServiceEvent) => void) | undefined
  const customState: CustomThemesState = {
    themes:
      customSelectedId === null
        ? []
        : [
            {
              id: customSelectedId,
              name: 'Custom active',
              colors: { accent: '#abcdef', background: '#fff', foreground: '#000', contrast: '#eee' },
            },
          ],
    selectedId: customSelectedId,
  }
  const values = new Map<LocalPrefKey, unknown>([[LocalPrefKey.CustomThemes, customState]])
  const selectTheme = jest.fn(async (theme: FakeTheme) => {
    activeId = theme.uniqueIdentifier.value
  })
  const selectDefaultTheme = jest.fn(async () => {
    activeId = NativeFeatureIdentifier.TYPES.StandardRedTheme
  })

  const application = {
    items: {
      streamItems: jest.fn((_contentType: string, observer: () => void) => {
        themeStreamObserver = observer
        return jest.fn()
      }),
    },
    preferences: {
      getLocalValue: jest.fn((key: LocalPrefKey, fallback?: unknown) => values.get(key) ?? fallback),
      setLocalValue: jest.fn((key: LocalPrefKey, value: unknown) => {
        values.set(key, value)
      }),
      addEventObserver: jest.fn((observer: (event: PreferencesServiceEvent) => void) => {
        preferenceObserver = observer
        return jest.fn()
      }),
    },
    componentManager: {
      getActiveThemes: jest.fn(() => initialThemes.filter((theme) => theme.uniqueIdentifier.value === activeId)),
      isThemeActive: jest.fn((theme: FakeTheme) => theme.uniqueIdentifier.value === activeId),
    },
    features: {
      isThirdPartyFeature: jest.fn((identifier: string) => identifier.startsWith('third-party')),
      getFeatureStatus: jest.fn(() => FeatureStatus.Entitled),
    },
    themeManager: {
      selectTheme,
      selectDefaultTheme,
      setColorSchemeMode: jest.fn(),
    },
  } as unknown as WebApplication

  return {
    application,
    selectDefaultTheme,
    selectTheme,
    emitPreferenceChange() {
      preferenceObserver?.(PreferencesServiceEvent.LocalPreferencesChanged)
    },
    emitThemeStream() {
      themeStreamObserver?.()
    },
    setActiveId(id: string | undefined) {
      activeId = id
    },
  }
}

describe('BaseThemePalette', () => {
  let container: HTMLElement
  let root: Root
  let themes: FakeTheme[]

  beforeEach(() => {
    themes = [
      fakeTheme(NativeFeatureIdentifier.TYPES.StandardRedTheme, 'Standard Red', STANDARD_RED_SWATCH),
      fakeTheme('native-blue', 'Blue', '#086dd6'),
      fakeTheme('third-party-ocean', 'Ocean', '#123456'),
    ]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('renders accessible responsive choices, dock swatches, and the active theme', () => {
    const harness = createApplication(themes, 'native-blue')
    act(() =>
      root.render(createElement(BaseThemePalette, { application: harness.application, loadThemes: () => themes })),
    )

    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(radios.map((radio) => radio.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Standard Red'),
        expect.stringContaining('Blue'),
        expect.stringContaining('Ocean'),
      ]),
    )
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Base theme')
    expect(container.querySelector('[data-theme-id="native-blue"]')?.getAttribute('aria-checked')).toBe('true')
    expect(
      container
        .querySelector(`[data-theme-id="${NativeFeatureIdentifier.TYPES.StandardRedTheme}"]`)
        ?.getAttribute('aria-checked'),
    ).toBe('false')

    const defaultSwatch = container.querySelector<HTMLElement>(
      `[data-theme-id="${NativeFeatureIdentifier.TYPES.StandardRedTheme}"] [aria-hidden="true"]`,
    )
    const oceanSwatch = container.querySelector<HTMLElement>('[data-theme-id="third-party-ocean"] [aria-hidden="true"]')
    expect(defaultSwatch?.style.backgroundColor).toBe('rgb(232, 95, 109)')
    expect(STANDARD_RED_SWATCH).toBe('#e85f6d')
    expect(oceanSwatch?.style.backgroundColor).toBe('rgb(18, 52, 86)')
  })

  it('routes default and installed-theme choices through the durable selector', async () => {
    const harness = createApplication(themes)
    await act(async () =>
      root.render(createElement(BaseThemePalette, { application: harness.application, loadThemes: () => themes })),
    )

    await act(async () => container.querySelector<HTMLButtonElement>('[data-theme-id="third-party-ocean"]')?.click())
    expect(harness.selectTheme).toHaveBeenCalledWith(themes[2])

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-theme-id="${NativeFeatureIdentifier.TYPES.StandardRedTheme}"]`)
        ?.click(),
    )
    expect(harness.selectDefaultTheme).toHaveBeenCalledTimes(1)
  })

  it('shows no built-in choice as active while a custom theme owns appearance', () => {
    const harness = createApplication(themes, 'native-blue', 'custom-theme:active')
    act(() =>
      root.render(createElement(BaseThemePalette, { application: harness.application, loadThemes: () => themes })),
    )

    const checked = Array.from(container.querySelectorAll('[role="radio"]')).filter(
      (radio) => radio.getAttribute('aria-checked') === 'true',
    )
    expect(checked).toHaveLength(0)
  })

  it('refreshes installed third-party themes and active state from their event streams', () => {
    const harness = createApplication(themes)
    act(() =>
      root.render(createElement(BaseThemePalette, { application: harness.application, loadThemes: () => themes })),
    )
    expect(container.querySelector('[data-theme-id="third-party-forest"]')).toBeNull()

    themes = [...themes, fakeTheme('third-party-forest', 'Forest', '#228833')]
    act(() => harness.emitThemeStream())
    expect(container.querySelector('[data-theme-id="third-party-forest"]')).not.toBeNull()

    harness.setActiveId('third-party-forest')
    act(() => harness.emitPreferenceChange())
    expect(container.querySelector('[data-theme-id="third-party-forest"]')?.getAttribute('aria-checked')).toBe('true')
  })
})
