/**
 * @jest-environment jsdom
 */

import { FindNativeTheme, NativeFeatureIdentifier, ThemeFeatureDescription } from '@standardnotes/features'
import { UIFeature } from '@standardnotes/models'
import {
  ApplicationEvent,
  ComponentManagerInterface,
  CurrentColorSchemeModeVersion,
  FeatureStatus,
  LocalPrefDefaults,
  LocalPrefKey,
  PreferenceServiceInterface,
} from '@standardnotes/services'
import { ThemeManager } from './ThemeManager'

type PreferenceValues = Map<LocalPrefKey, unknown>
type HarnessOptions = {
  cachedThemeIdentifiers?: string[]
  isNativeMobileWeb?: boolean
  getMobileColorScheme?: () => Promise<'dark' | 'light'>
  themeUrl?: string
  unversionedColorSchemeState?: boolean
}

function nativeTheme(identifier: string): UIFeature<ThemeFeatureDescription> {
  const feature = FindNativeTheme(identifier)
  if (!feature) {
    throw new Error(`Missing native theme fixture: ${identifier}`)
  }
  return new UIFeature(feature)
}

function createHarness(initialPreferences: Partial<Record<LocalPrefKey, unknown>> = {}, options: HarnessOptions = {}) {
  const values: PreferenceValues = new Map(Object.entries(initialPreferences) as [LocalPrefKey, unknown][])
  if (!options.unversionedColorSchemeState) {
    values.set(LocalPrefKey.ColorSchemeModeVersion, CurrentColorSchemeModeVersion)
  }
  const activeThemes: UIFeature<ThemeFeatureDescription>[] = []
  const colorSchemeListeners: ((event: MediaQueryListEvent) => void)[] = []
  let systemPrefersDark = false

  const cachedThemes = options.cachedThemeIdentifiers?.map((identifier) => {
    const feature = FindNativeTheme(identifier)
    if (!feature) {
      throw new Error(`Missing cached native theme fixture: ${identifier}`)
    }
    return feature
  })

  const preferences = {
    getLocalValue: jest.fn((key: LocalPrefKey, defaultValue?: unknown) => values.get(key) ?? defaultValue),
    setLocalValue: jest.fn((key: LocalPrefKey, value: unknown) => {
      values.set(key, value)
    }),
  } as unknown as PreferenceServiceInterface

  const items = {
    getDisplayableComponents: jest.fn(() => []),
    findItem: jest.fn(),
  }

  const components = {
    getActiveThemes: jest.fn(() => activeThemes.slice()),
    getActiveThemesIdentifiers: jest.fn(() => ({
      features: activeThemes.map((theme) => theme.uniqueIdentifier),
      uuids: [],
    })),
    isThemeActive: jest.fn((theme: UIFeature<ThemeFeatureDescription>) =>
      activeThemes.some((candidate) => candidate.featureIdentifier === theme.featureIdentifier),
    ),
    toggleTheme: jest.fn(async (theme: UIFeature<ThemeFeatureDescription>) => {
      const index = activeThemes.findIndex((candidate) => candidate.featureIdentifier === theme.featureIdentifier)
      if (index >= 0) {
        activeThemes.splice(index, 1)
        return
      }

      activeThemes.push(theme)
      if (!theme.layerable) {
        for (let candidateIndex = activeThemes.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
          const candidate = activeThemes[candidateIndex]
          if (candidate !== theme && !candidate.layerable) {
            activeThemes.splice(candidateIndex, 1)
          }
        }
      }
    }),
    toggleOtherNonLayerableThemes: jest.fn((theme: UIFeature<ThemeFeatureDescription>) => {
      for (let index = activeThemes.length - 1; index >= 0; index -= 1) {
        const candidate = activeThemes[index]
        if (candidate !== theme && !candidate.layerable) {
          activeThemes.splice(index, 1)
        }
      }
    }),
    urlForFeature: jest.fn(() => options.themeUrl),
  } as unknown as ComponentManagerInterface

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn((query: string) => ({
      matches: query.includes('dark') ? systemPrefersDark : !systemPrefersDark,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (query.includes('dark')) {
          colorSchemeListeners.push(listener)
        }
      },
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
    })),
  })

  const application = {
    items,
    componentManager: components,
    features: {
      getFeatureStatus: jest.fn(() => FeatureStatus.Entitled),
    },
    mobileDevice: {
      getColorScheme: jest.fn(options.getMobileColorScheme ?? (async () => (systemPrefersDark ? 'dark' : 'light'))),
      handleThemeSchemeChange: jest.fn(),
    },
    desktopManager: undefined,
    isNativeMobileWeb: jest.fn(() => options.isNativeMobileWeb ?? false),
    isStarted: jest.fn(() => false),
    addEventObserver: jest.fn(() => jest.fn()),
    getValue: jest.fn(() => cachedThemes),
    setValue: jest.fn(async () => undefined),
    removeValue: jest.fn(async () => undefined),
  }

  const manager = new ThemeManager(application as never, preferences, components, {} as never)

  return {
    activeThemes,
    application,
    colorSchemeListeners,
    components,
    manager,
    preferences,
    setSystemPrefersDark(value: boolean) {
      systemPrefersDark = value
    },
    values,
  }
}

describe('ThemeManager persistence and color-scheme ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    document.head.querySelectorAll('link[rel="stylesheet"]').forEach((element) => element.remove())
    document.head.querySelector('meta[name="theme-color"]')?.remove()
    document.documentElement.style.removeProperty('--sn-stylekit-background-color')
    document.body.classList.remove('translucent-ui')
  })

  it('does not apply an automatic theme at StorageReady before local preferences are decrypted', async () => {
    const { manager, components, preferences } = createHarness()

    await manager.onAppEvent(ApplicationEvent.StorageReady)

    expect(components.toggleTheme).not.toHaveBeenCalled()
    expect(preferences.setLocalValue).not.toHaveBeenCalled()
  })

  it('uses Standard Red as the dark-first default on a fresh launch', async () => {
    const standardRed = nativeTheme(NativeFeatureIdentifier.TYPES.StandardRedTheme)
    const { manager, activeThemes, components, preferences, values } = createHarness(
      {},
      { unversionedColorSchemeState: true },
    )

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(LocalPrefDefaults[LocalPrefKey.ColorSchemeMode]).toBe('dark')
    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('dark')
    expect(values.get(LocalPrefKey.ColorSchemeModeVersion)).toBe(CurrentColorSchemeModeVersion)
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'dark', {
      source: 'implicit',
    })
    expect(components.toggleTheme).toHaveBeenCalledWith(
      expect.objectContaining({ featureIdentifier: standardRed.featureIdentifier }),
      true,
    )
    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([standardRed.featureIdentifier])
  })

  it('resets the ambiguous previous unversioned Auto state to dark once', async () => {
    const { manager, components, preferences, values } = createHarness(
      { [LocalPrefKey.ColorSchemeMode]: 'auto' },
      { unversionedColorSchemeState: true },
    )

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('dark')
    expect(values.get(LocalPrefKey.ColorSchemeModeVersion)).toBe(CurrentColorSchemeModeVersion)
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'dark', {
      source: 'implicit',
    })
    expect(components.toggleTheme).toHaveBeenCalledWith(
      expect.objectContaining({ featureIdentifier: NativeFeatureIdentifier.TYPES.StandardRedTheme }),
      true,
    )

    manager.setColorSchemeMode('auto')
    await manager.applyColorSchemeMode()

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('auto')
    expect(components.toggleTheme).toHaveBeenCalled()
  })

  it('removes an Auto-activated cached light theme while migrating an existing installation', async () => {
    const blueTheme = nativeTheme(NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme)
    const { manager, activeThemes } = createHarness(
      {
        [LocalPrefKey.ActiveThemes]: [blueTheme.uniqueIdentifier.value],
        [LocalPrefKey.ColorSchemeMode]: 'auto',
      },
      {
        cachedThemeIdentifiers: [NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme],
        themeUrl: '/cached-standard-blue.css',
        unversionedColorSchemeState: true,
      },
    )
    activeThemes.push(blueTheme)

    await manager.onAppEvent(ApplicationEvent.StorageReady)
    expect(document.getElementById(blueTheme.uniqueIdentifier.value)).toBeInstanceOf(HTMLLinkElement)

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
    ])
    expect(document.getElementById(blueTheme.uniqueIdentifier.value)).toBeNull()
  })

  it('normalizes a malformed persisted mode to dark', async () => {
    const { manager, components, preferences, values } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'unexpected-mode',
    })

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('dark')
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'dark', {
      source: 'implicit',
    })
    expect(components.toggleTheme).toHaveBeenCalledWith(
      expect.objectContaining({ featureIdentifier: NativeFeatureIdentifier.TYPES.StandardRedTheme }),
      true,
    )
  })

  it('removes a stale cached light-theme stylesheet once preferences are available', async () => {
    const blueTheme = nativeTheme(NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme)
    const { manager } = createHarness(
      { [LocalPrefKey.ColorSchemeMode]: 'manual' },
      {
        cachedThemeIdentifiers: [NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme],
        themeUrl: '/cached-standard-blue.css',
      },
    )

    await manager.onAppEvent(ApplicationEvent.StorageReady)
    expect(document.getElementById(blueTheme.uniqueIdentifier.value)).toBeInstanceOf(HTMLLinkElement)

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(document.getElementById(blueTheme.uniqueIdentifier.value)).toBeNull()
  })

  it('restores dark browser and native metadata after removing the final cached theme', async () => {
    const themeColor = document.createElement('meta')
    themeColor.name = 'theme-color'
    themeColor.content = '#ffffff'
    document.head.appendChild(themeColor)

    const { manager, application } = createHarness(
      { [LocalPrefKey.ColorSchemeMode]: 'manual' },
      {
        cachedThemeIdentifiers: [NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme],
        isNativeMobileWeb: true,
        themeUrl: '/cached-standard-blue.css',
      },
    )

    await manager.onAppEvent(ApplicationEvent.StorageReady)
    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(themeColor.content).toBe('#16090f')
    expect(application.mobileDevice.handleThemeSchemeChange).toHaveBeenCalledWith(true, '#16090f')
  })

  it('migrates a pre-mode saved theme to manual and preserves it on launch', async () => {
    const savedTheme = nativeTheme(NativeFeatureIdentifier.TYPES.DarkTheme)
    const { manager, components, preferences, activeThemes, values } = createHarness(
      {
        [LocalPrefKey.ActiveThemes]: [savedTheme.uniqueIdentifier.value],
      },
      { unversionedColorSchemeState: true },
    )
    activeThemes.push(savedTheme)

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('manual')
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'manual', {
      source: 'implicit',
    })
    expect(components.toggleTheme).not.toHaveBeenCalled()
  })

  it('keeps an explicit manual selection stable across launch', async () => {
    const savedTheme = nativeTheme(NativeFeatureIdentifier.TYPES.DarkTheme)
    const { manager, components, activeThemes } = createHarness({
      [LocalPrefKey.ActiveThemes]: [savedTheme.uniqueIdentifier.value],
      [LocalPrefKey.ColorSchemeMode]: 'manual',
    })
    activeThemes.push(savedTheme)

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(components.toggleTheme).not.toHaveBeenCalled()
  })

  it('persists non-layerable user choices as manual before toggling the theme', async () => {
    const selectedTheme = nativeTheme(NativeFeatureIdentifier.TYPES.DarkTheme)
    const { manager, components, preferences, values } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'auto',
      [LocalPrefKey.UseSystemColorScheme]: true,
    })

    await manager.selectTheme(selectedTheme)

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('manual')
    expect(values.get(LocalPrefKey.UseSystemColorScheme)).toBe(false)
    expect(preferences.setLocalValue).toHaveBeenNthCalledWith(1, LocalPrefKey.UseSystemColorScheme, false)
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'manual')
    expect(components.toggleTheme).toHaveBeenCalledWith(selectedTheme)
  })

  it('persists Standard Red as Manual even when no non-layerable theme is currently active', async () => {
    const standardRed = nativeTheme(NativeFeatureIdentifier.TYPES.StandardRedTheme)
    const { manager, components, preferences, values } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'auto',
      [LocalPrefKey.UseSystemColorScheme]: true,
    })

    await manager.selectDefaultTheme()

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('manual')
    expect(values.get(LocalPrefKey.UseSystemColorScheme)).toBe(false)
    expect(preferences.setLocalValue).toHaveBeenNthCalledWith(1, LocalPrefKey.UseSystemColorScheme, false)
    expect(preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'manual')
    expect(components.toggleTheme).toHaveBeenCalledWith(
      expect.objectContaining({ featureIdentifier: standardRed.featureIdentifier }),
      true,
    )
  })

  it('persists Standard Red and removes the active non-layerable theme', async () => {
    const standardRed = nativeTheme(NativeFeatureIdentifier.TYPES.StandardRedTheme)
    const selectedTheme = nativeTheme(NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme)
    const { manager, components, activeThemes, values } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'light',
    })
    activeThemes.push(selectedTheme)

    await manager.selectDefaultTheme()

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('manual')
    expect(components.toggleTheme).toHaveBeenCalledWith(
      expect.objectContaining({ featureIdentifier: standardRed.featureIdentifier }),
      true,
    )
    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([standardRed.featureIdentifier])
  })

  it('keeps layerable theme overlays independent from the base color-scheme mode', async () => {
    const overlay = nativeTheme(NativeFeatureIdentifier.TYPES.DynamicTheme)
    const { manager, components, preferences, values } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'auto',
      [LocalPrefKey.UseSystemColorScheme]: true,
    })

    await manager.selectTheme(overlay)

    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('auto')
    expect(values.get(LocalPrefKey.UseSystemColorScheme)).toBe(true)
    expect(preferences.setLocalValue).not.toHaveBeenCalled()
    expect(components.toggleTheme).toHaveBeenCalledWith(overlay)
  })

  it('follows OS changes only while Auto owns the base theme', async () => {
    const { manager, components, colorSchemeListeners, activeThemes, values, setSystemPrefersDark } = createHarness({
      [LocalPrefKey.ColorSchemeMode]: 'auto',
    })

    await manager.onAppEvent(ApplicationEvent.Launched)

    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme,
    ])
    expect(colorSchemeListeners).toHaveLength(1)

    setSystemPrefersDark(true)
    colorSchemeListeners[0]({ matches: true } as MediaQueryListEvent)

    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
    ])
    expect(values.get(LocalPrefKey.ColorSchemeMode)).toBe('auto')

    jest.mocked(components.toggleTheme).mockClear()
    manager.setColorSchemeMode('manual')
    colorSchemeListeners[0]({ matches: false } as MediaQueryListEvent)
    expect(components.toggleTheme).not.toHaveBeenCalled()
  })

  it('does not apply a stale asynchronous Auto result after the user selects Manual', async () => {
    let resolveMobileColorScheme!: (scheme: 'dark' | 'light') => void
    const pendingMobileColorScheme = new Promise<'dark' | 'light'>((resolve) => {
      resolveMobileColorScheme = resolve
    })
    const { manager, components, application } = createHarness(
      { [LocalPrefKey.ColorSchemeMode]: 'auto' },
      {
        isNativeMobileWeb: true,
        getMobileColorScheme: () => pendingMobileColorScheme,
      },
    )

    const pendingApply = manager.applyColorSchemeMode()
    expect(application.mobileDevice.getColorScheme).toHaveBeenCalledTimes(1)

    manager.setColorSchemeMode('manual')
    resolveMobileColorScheme('light')

    await expect(pendingApply).resolves.toBe(false)
    expect(components.toggleTheme).not.toHaveBeenCalled()
  })

  it('follows mobile OS color changes in Auto but leaves the base theme alone in Manual', async () => {
    const { manager, components, application, activeThemes, setSystemPrefersDark } = createHarness(
      { [LocalPrefKey.ColorSchemeMode]: 'auto' },
      { isNativeMobileWeb: true },
    )

    await manager.handleMobileColorSchemeChangeEvent()
    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme,
    ])

    setSystemPrefersDark(true)
    await manager.handleMobileColorSchemeChangeEvent()
    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
    ])

    manager.setColorSchemeMode('manual')
    jest.mocked(components.toggleTheme).mockClear()
    jest.mocked(application.mobileDevice.getColorScheme).mockClear()
    setSystemPrefersDark(false)

    await manager.handleMobileColorSchemeChangeEvent()

    expect(application.mobileDevice.getColorScheme).not.toHaveBeenCalled()
    expect(components.toggleTheme).not.toHaveBeenCalled()
    expect(activeThemes.map((theme) => theme.featureIdentifier)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
    ])
  })
})
