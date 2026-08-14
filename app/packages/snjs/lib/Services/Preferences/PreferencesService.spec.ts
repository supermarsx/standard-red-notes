import {
  CurrentUserAppearancePreferenceVersion,
  normalizeUserAppearancePreference,
  PrefKey,
  SNUserPrefs,
  UserAppearancePreference,
  UserPrefsMutator,
} from '@standardnotes/models'
import { NativeFeatureIdentifier } from '@standardnotes/features'
import {
  ApplicationEvent,
  ApplicationStage,
  CurrentColorSchemeModeVersion,
  InternalEventInterface,
  LocalPrefKey,
  LocalPrefValue,
  MutatorClientInterface,
  StorageKey,
  StorageServiceInterface,
  SyncEvent,
} from '@standardnotes/services'
import { ItemManager } from '../Items/ItemManager'
import { SingletonManager } from '../Singleton/SingletonManager'
import { SyncService } from '../Sync/SyncService'
import { PreferencesService } from './PreferencesService'

type LocalPreferences = { [key in LocalPrefKey]?: LocalPrefValue[key] }

function appearance(colorSchemeMode: UserAppearancePreference['colorSchemeMode'], activeThemes: string[]) {
  return {
    version: CurrentUserAppearancePreferenceVersion,
    colorSchemeMode,
    activeThemes,
  } satisfies UserAppearancePreference
}

function stageEvent(stage: ApplicationStage): InternalEventInterface {
  return {
    type: ApplicationEvent.ApplicationStageChanged,
    payload: { stage },
  }
}

function signOutLifecycleEvent(phase: 'begin' | 'commit' | 'cancel'): InternalEventInterface {
  return {
    type: ApplicationEvent.PreparingForSignOut,
    payload: { phase },
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

function createHarness(
  initialLocal: LocalPreferences,
  initialSynced: Map<PrefKey, unknown>,
  options: { changeItemGate?: Promise<void> } = {},
) {
  let storedLocal: LocalPreferences = { ...initialLocal }
  const synced = new Map(initialSynced)
  let modifiedAt = 1
  let itemObserver: (() => void) | undefined
  let syncObserver: ((event: SyncEvent) => void) | undefined

  const createPreferences = () =>
    ({
      uuid: 'user-preferences',
      userModifiedDate: new Date(modifiedAt++),
      getPref: (key: PrefKey) => synced.get(key),
    }) as unknown as SNUserPrefs

  let preferences = createPreferences()

  const singletons = {
    findSingleton: jest.fn(() => preferences),
    findOrCreateContentTypeSingleton: jest.fn(async () => preferences),
  } as unknown as SingletonManager

  const items = {
    addObserver: jest.fn((_contentType: string, observer: () => void) => {
      itemObserver = observer
      return () => undefined
    }),
    findItem: jest.fn(() => undefined),
  } as unknown as ItemManager

  const mutator = {
    changeItem: jest.fn(async (_item: SNUserPrefs, mutate: (mutator: UserPrefsMutator) => void) => {
      mutate({ setPref: (key: PrefKey, value: unknown) => synced.set(key, value) } as unknown as UserPrefsMutator)
      await options.changeItemGate
      preferences = createPreferences()
      return preferences
    }),
  } as unknown as MutatorClientInterface

  const sync = {
    addEventObserver: jest.fn((observer: (event: SyncEvent) => void) => {
      syncObserver = observer
      return () => undefined
    }),
    sync: jest.fn(async () => undefined),
  } as unknown as SyncService

  const storage = {
    getValue: jest.fn((key: StorageKey) => (key === StorageKey.LocalPreferences ? storedLocal : undefined)),
    setValue: jest.fn((key: StorageKey, value: unknown) => {
      if (key === StorageKey.LocalPreferences) {
        storedLocal = { ...(value as LocalPreferences) }
      }
    }),
  } as unknown as StorageServiceInterface

  const service = new PreferencesService(singletons, items, mutator, sync, storage, {
    publish: jest.fn(),
    publishSync: jest.fn(async () => undefined),
  } as never)

  return {
    service,
    synced,
    mutator: mutator as jest.Mocked<MutatorClientInterface>,
    sync: sync as jest.Mocked<SyncService>,
    getStoredLocal: () => storedLocal,
    setSyncedValue: (key: PrefKey, value: unknown) => {
      synced.set(key, value)
      preferences = createPreferences()
      itemObserver?.()
    },
    receiveSyncedAppearance: async (nextAppearance: UserAppearancePreference) => {
      synced.set(PrefKey.UserAppearance, nextAppearance)
      preferences = createPreferences()
      itemObserver?.()
      syncObserver?.(SyncEvent.SyncCompletedWithAllItemsUploaded)
      await flushAsyncWork()
    },
  }
}

describe('PreferencesService synced appearance', () => {
  it('restores the signed-in user appearance after device-local storage was cleared', async () => {
    const harness = createHarness(
      {},
      new Map([[PrefKey.UserAppearance, appearance('manual', ['org.standardnotes.theme-focus'])]]),
    )

    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('manual')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([
      'org.standardnotes.theme-focus',
    ])
    expect(harness.mutator.changeItem).not.toHaveBeenCalled()
    expect(harness.sync.sync).not.toHaveBeenCalled()
  })

  it('hydrates the encrypted local cache from the synced user preference', async () => {
    const harness = createHarness(
      {
        [LocalPrefKey.ColorSchemeMode]: 'light',
        [LocalPrefKey.ColorSchemeModeVersion]: CurrentColorSchemeModeVersion,
        [LocalPrefKey.ActiveThemes]: ['org.standardnotes.theme-standard-notes-blue'],
        [LocalPrefKey.UseSystemColorScheme]: true,
      },
      new Map([[PrefKey.UserAppearance, appearance('manual', ['org.standardnotes.theme-focus'])]]),
    )

    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('manual')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([
      'org.standardnotes.theme-focus',
    ])
    expect(harness.service.getLocalValue(LocalPrefKey.UseSystemColorScheme, undefined)).toBe(false)
    expect(harness.getStoredLocal()[LocalPrefKey.ColorSchemeModeVersion]).toBe(CurrentColorSchemeModeVersion)
  })

  it('coalesces an explicit manual base-theme selection into the synced preference', async () => {
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, [
      'org.standardnotes.theme-focus',
      'org.standardnotes.theme-focus',
    ])
    await flushAsyncWork()

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))
    expect(harness.sync.sync).toHaveBeenCalledWith({ sourceDescription: 'PreferencesService.setValue' })
  })

  it('does not let stale hydration overwrite a newer explicit local choice from the same launch', async () => {
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, ['org.standardnotes.theme-focus'])
    await flushAsyncWork()

    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('manual')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([
      'org.standardnotes.theme-focus',
    ])
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))

    await harness.receiveSyncedAppearance(appearance('dark', []))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('manual')
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))
  })

  it('lets a valid remote appearance outrank implicit launch normalization on a fresh device', async () => {
    const harness = createHarness({ [LocalPrefKey.ColorSchemeMode]: 'auto' }, new Map())
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'dark', { source: 'implicit' })
    harness.setSyncedValue(PrefKey.UserAppearance, appearance('light', []))
    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('light')
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('light', []))
    expect(harness.mutator.changeItem).not.toHaveBeenCalled()
  })

  it('keeps an explicit pre-sync user choice over a racing remote appearance', async () => {
    const harness = createHarness({ [LocalPrefKey.ColorSchemeMode]: 'auto' }, new Map())
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'dark')
    harness.setSyncedValue(PrefKey.UserAppearance, appearance('light', []))
    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('dark')
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('dark', []))
  })

  it('bootstraps upgraded local appearance after first sync when the account has no synced value', async () => {
    const harness = createHarness(
      {
        [LocalPrefKey.ColorSchemeMode]: 'manual',
        [LocalPrefKey.ColorSchemeModeVersion]: CurrentColorSchemeModeVersion,
        [LocalPrefKey.ActiveThemes]: ['org.standardnotes.theme-focus'],
      },
      new Map(),
    )
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))
    expect(harness.synced.has(PrefKey.UserAppearance)).toBe(false)

    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('manual', ['org.standardnotes.theme-focus']))
  })

  it('does not manufacture a synced value for an untouched first-sync client', async () => {
    const harness = createHarness({}, new Map())
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))
    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(harness.synced.has(PrefKey.UserAppearance)).toBe(false)
  })

  it('imports deprecated synced appearance at runtime even when the old migration is no longer reachable', async () => {
    const harness = createHarness({ [LocalPrefKey.ColorSchemeMode]: 'auto' }, new Map())
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'dark', { source: 'implicit' })
    harness.setSyncedValue(PrefKey.DEPRECATED_ActiveThemes, [NativeFeatureIdentifier.TYPES.DarkTheme])
    harness.setSyncedValue(PrefKey.DEPRECATED_UseSystemColorScheme, false)

    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('manual')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([
      NativeFeatureIdentifier.TYPES.DarkTheme,
    ])
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(
      appearance('manual', [NativeFeatureIdentifier.TYPES.DarkTheme]),
    )
  })

  it('does not downgrade an unknown future appearance schema', async () => {
    const futureAppearance = {
      version: CurrentUserAppearancePreferenceVersion + 1,
      colorSchemeMode: 'light',
      activeThemes: ['future-theme'],
    }
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, futureAppearance]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, ['org.standardnotes.theme-focus'])
    await flushAsyncWork()

    expect(harness.synced.get(PrefKey.UserAppearance)).toBe(futureAppearance)
    expect(harness.mutator.changeItem).not.toHaveBeenCalled()
  })

  it('repairs malformed current-v1 appearance without retaining unbounded or invalid identifiers', async () => {
    const malformed = {
      version: CurrentUserAppearancePreferenceVersion,
      colorSchemeMode: 'neon',
      activeThemes: [' custom-overlay ', '', 42, 'custom-overlay', 'x'.repeat(257)],
    }
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, malformed]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))
    await harness.service.handleEvent(stageEvent(ApplicationStage.FullSyncCompleted_13))

    expect(normalizeUserAppearancePreference(malformed)).toEqual(appearance('dark', ['custom-overlay']))
    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(appearance('dark', ['custom-overlay']))
    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('dark')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual(['custom-overlay'])
  })

  it('canonicalizes the ComponentManager old-plus-new transition to one non-layerable base', async () => {
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, [
      NativeFeatureIdentifier.TYPES.DarkTheme,
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
      NativeFeatureIdentifier.TYPES.DynamicTheme,
    ])
    await flushAsyncWork()

    expect(harness.synced.get(PrefKey.UserAppearance)).toEqual(
      appearance('manual', [
        NativeFeatureIdentifier.TYPES.StandardRedTheme,
        NativeFeatureIdentifier.TYPES.DynamicTheme,
      ]),
    )
  })

  it('cancels a scheduled appearance write when deinitialized before it starts', async () => {
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    harness.service.deinit()
    await flushAsyncWork()

    expect(harness.mutator.changeItem).not.toHaveBeenCalled()
    expect(harness.sync.sync).not.toHaveBeenCalled()
  })

  it('blocks deinit until an in-flight appearance mutation is safely finished', async () => {
    let releaseMutation!: () => void
    const changeItemGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]), { changeItemGate })
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    await Promise.resolve()
    await Promise.resolve()

    let didFinishBlocking = false
    const blocking = harness.service.blockDeinit().then(() => {
      didFinishBlocking = true
    })
    await flushAsyncWork()
    expect(didFinishBlocking).toBe(false)

    releaseMutation()
    await blocking
    expect(harness.mutator.changeItem).toHaveBeenCalledTimes(1)
    expect(harness.sync.sync).toHaveBeenCalledTimes(1)
  })

  it('drains and fences appearance writes at the final pre-clear sign-out barrier', async () => {
    let releaseMutation!: () => void
    const changeItemGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]), { changeItemGate })
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    harness.service.setLocalValue(LocalPrefKey.ColorSchemeMode, 'manual')
    let barrierFinished = false
    const barrier = harness.service.handleEvent(signOutLifecycleEvent('commit')).then(() => {
      barrierFinished = true
    })
    await flushAsyncWork()
    expect(barrierFinished).toBe(false)

    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, [NativeFeatureIdentifier.TYPES.StandardRedTheme])
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([])

    releaseMutation()
    await barrier
    expect(harness.mutator.changeItem).toHaveBeenCalledTimes(1)

    await harness.service.handleEvent(signOutLifecycleEvent('cancel'))
    harness.service.setLocalValue(LocalPrefKey.ActiveThemes, [NativeFeatureIdentifier.TYPES.StandardRedTheme])
    await flushAsyncWork()
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([
      NativeFeatureIdentifier.TYPES.StandardRedTheme,
    ])
  })

  it('keeps draining when a reconcile write replaces the queue during the sign-out barrier', async () => {
    let releaseFirstQueue!: () => void
    let releaseSecondQueue!: () => void
    const firstQueue = new Promise<void>((resolve) => {
      releaseFirstQueue = resolve
    })
    const secondQueue = new Promise<void>((resolve) => {
      releaseSecondQueue = resolve
    })
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    const internals = harness.service as unknown as { appearanceWriteQueue: Promise<void> }
    internals.appearanceWriteQueue = firstQueue

    let barrierFinished = false
    const barrier = harness.service.handleEvent(signOutLifecycleEvent('commit')).then(() => {
      barrierFinished = true
    })
    await Promise.resolve()

    internals.appearanceWriteQueue = secondQueue
    releaseFirstQueue()
    await flushAsyncWork()
    expect(barrierFinished).toBe(false)

    releaseSecondQueue()
    await barrier
    expect(barrierFinished).toBe(true)
  })

  it('applies a newer appearance received by sync on another device', async () => {
    const harness = createHarness({}, new Map([[PrefKey.UserAppearance, appearance('dark', [])]]))
    await harness.service.handleEvent(stageEvent(ApplicationStage.StorageDecrypted_09))
    await harness.service.handleEvent(stageEvent(ApplicationStage.LoadedDatabase_12))

    await harness.receiveSyncedAppearance(appearance('light', []))

    expect(harness.service.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)).toBe('light')
    expect(harness.service.getLocalValue(LocalPrefKey.ActiveThemes, undefined)).toEqual([])
  })
})
