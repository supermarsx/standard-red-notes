import { CurrentUserAppearancePreferenceVersion, PrefKey, UserAppearancePreference } from '@standardnotes/models'
import {
  ApplicationStage,
  CurrentColorSchemeModeVersion,
  LocalPrefKey,
  LocalPrefValue,
  PreferenceServiceInterface,
} from '@standardnotes/services'
import { MigrationServices } from '../MigrationServices'
import { Migration2_208_0 } from './2_208_0'

type LocalPreferences = { [key in LocalPrefKey]?: LocalPrefValue[key] }

function appearance(colorSchemeMode: UserAppearancePreference['colorSchemeMode'], activeThemes: string[]) {
  return {
    version: CurrentUserAppearancePreferenceVersion,
    colorSchemeMode,
    activeThemes,
  } satisfies UserAppearancePreference
}

function createHarness(initialLocal: LocalPreferences, initialSynced: Map<PrefKey, unknown>) {
  const local: LocalPreferences = { ...initialLocal }
  const synced = new Map(initialSynced)
  const preferences = {
    getLocalValue: jest.fn((key: LocalPrefKey, defaultValue?: unknown) => local[key] ?? defaultValue),
    setLocalValue: jest.fn((key: LocalPrefKey, value: LocalPrefValue[LocalPrefKey]) => {
      local[key] = value
    }),
    getValue: jest.fn((key: PrefKey, defaultValue?: unknown) => synced.get(key) ?? defaultValue),
    setValueDetached: jest.fn(async (key: PrefKey, value: unknown) => {
      synced.set(key, value)
    }),
  } as unknown as jest.Mocked<PreferenceServiceInterface>

  const migration = new Migration2_208_0({ preferences } as unknown as MigrationServices)

  return { migration, preferences, local, synced }
}

describe('Migration2_208_0 appearance precedence', () => {
  it('never overwrites an already-synced versioned appearance', async () => {
    const existing = appearance('light', ['org.standardnotes.theme-standard-notes-blue'])
    const harness = createHarness(
      {},
      new Map<PrefKey, unknown>([
        [PrefKey.UserAppearance, existing],
        [PrefKey.DEPRECATED_ActiveThemes, ['org.standardnotes.theme-focus']],
        [PrefKey.DEPRECATED_UseTranslucentUI, false],
      ]),
    )

    await harness.migration.handleStage(ApplicationStage.FullSyncCompleted_13)

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(existing)
    expect(harness.preferences.setValueDetached).not.toHaveBeenCalled()
    expect(harness.preferences.setLocalValue).toHaveBeenCalledTimes(1)
    expect(harness.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.UseTranslucentUI, false)
  })

  it('lets deprecated synced appearance outrank an implicit launch-time local migration', async () => {
    const harness = createHarness(
      {
        [LocalPrefKey.ColorSchemeMode]: 'manual',
        [LocalPrefKey.ColorSchemeModeVersion]: CurrentColorSchemeModeVersion,
        [LocalPrefKey.ActiveThemes]: ['org.standardnotes.theme-focus'],
        [LocalPrefKey.UseTranslucentUI]: false,
      },
      new Map<PrefKey, unknown>([
        [PrefKey.DEPRECATED_ActiveThemes, ['org.standardnotes.theme-standard-notes-blue']],
        [PrefKey.DEPRECATED_UseTranslucentUI, true],
      ]),
    )

    await harness.migration.handleStage(ApplicationStage.FullSyncCompleted_13)

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(
      appearance('manual', ['org.standardnotes.theme-standard-notes-blue']),
    )
    expect(harness.local[LocalPrefKey.ActiveThemes]).toEqual(['org.standardnotes.theme-standard-notes-blue'])
    expect(harness.local[LocalPrefKey.UseTranslucentUI]).toBe(false)
    expect(harness.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ColorSchemeMode, 'manual', {
      source: 'implicit',
    })
  })

  it('seeds a local-only upgraded appearance when no synced legacy value exists', async () => {
    const harness = createHarness(
      {
        [LocalPrefKey.ColorSchemeMode]: 'manual',
        [LocalPrefKey.ColorSchemeModeVersion]: CurrentColorSchemeModeVersion,
        [LocalPrefKey.ActiveThemes]: ['org.standardnotes.theme-focus'],
      },
      new Map(),
    )

    await harness.migration.handleStage(ApplicationStage.FullSyncCompleted_13)

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))
  })

  it('migrates legacy theme values into both the local cache and synced appearance', async () => {
    const harness = createHarness(
      {},
      new Map<PrefKey, unknown>([
        [PrefKey.DEPRECATED_ActiveThemes, ['org.standardnotes.theme-focus']],
        [PrefKey.DEPRECATED_UseSystemColorScheme, false],
        [PrefKey.DEPRECATED_AutoLightThemeIdentifier, 'Default'],
        [PrefKey.DEPRECATED_AutoDarkThemeIdentifier, 'org.standardnotes.theme-focus'],
        [PrefKey.DEPRECATED_UseTranslucentUI, true],
      ]),
    )

    await harness.migration.handleStage(ApplicationStage.FullSyncCompleted_13)

    expect(harness.local[LocalPrefKey.ColorSchemeMode]).toBe('manual')
    expect(harness.local[LocalPrefKey.ColorSchemeModeVersion]).toBe(CurrentColorSchemeModeVersion)
    expect(harness.local[LocalPrefKey.ActiveThemes]).toEqual(['org.standardnotes.theme-focus'])
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))
  })

  it('converts the legacy system-theme switch into the versioned auto mode', async () => {
    const harness = createHarness(
      {},
      new Map<PrefKey, unknown>([
        [PrefKey.DEPRECATED_ActiveThemes, []],
        [PrefKey.DEPRECATED_UseSystemColorScheme, true],
      ]),
    )

    await harness.migration.handleStage(ApplicationStage.FullSyncCompleted_13)

    expect(harness.local[LocalPrefKey.ColorSchemeMode]).toBe('auto')
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('auto', []))
  })
})
