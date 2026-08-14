import {
  SNUserPrefs,
  PrefKey,
  PrefValue,
  UserPrefsMutator,
  ItemContent,
  FillItemContent,
  CurrentUserAppearancePreferenceVersion,
  ComponentInterface,
  isFutureUserAppearancePreference,
  normalizeUserAppearancePreference,
  UserAppearancePreference,
} from '@standardnotes/models'
import { FindNativeTheme } from '@standardnotes/features'
import { ItemManager } from '../Items/ItemManager'
import { SingletonManager } from '../Singleton/SingletonManager'
import { SyncService } from '../Sync/SyncService'
import {
  AbstractService,
  InternalEventBusInterface,
  SyncEvent,
  ApplicationStage,
  PreferenceServiceInterface,
  PreferencesServiceEvent,
  MutatorClientInterface,
  InternalEventHandlerInterface,
  InternalEventInterface,
  ApplicationEvent,
  ApplicationStageChangedEventPayload,
  PreparingForSignOutEventPayload,
  StorageServiceInterface,
  StorageKey,
  LocalPrefKey,
  LocalPrefValue,
  LocalPrefDefaults,
  LocalPreferenceWriteOptions,
  CurrentColorSchemeModeVersion,
  ColorSchemeMode,
} from '@standardnotes/services'
import { ContentType } from '@standardnotes/domain-core'

export class PreferencesService
  extends AbstractService<PreferencesServiceEvent>
  implements PreferenceServiceInterface, InternalEventHandlerInterface
{
  private shouldReload = true
  private reloading = false
  private reloadPromise?: Promise<void>
  private preferences?: SNUserPrefs
  private localPreferences: { [key in LocalPrefKey]?: LocalPrefValue[key] } = {}
  private removeItemObserver?: () => void
  private removeSyncObserver?: () => void
  private appearanceExplicitlyDirty = false
  private appearanceWriteScheduled = false
  private appearanceWriteQueue: Promise<void> = Promise.resolve()
  private appearanceCriticalWrite?: Promise<void>
  private appearanceWritesFenced = false
  private deinitialized = false

  constructor(
    private singletons: SingletonManager,
    private items: ItemManager,
    private mutator: MutatorClientInterface,
    private sync: SyncService,
    private storage: StorageServiceInterface,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)

    this.removeItemObserver = items.addObserver(ContentType.TYPES.UserPrefs, () => {
      this.shouldReload = true
    })

    this.removeSyncObserver = sync.addEventObserver((event) => {
      if (event === SyncEvent.SyncCompletedWithAllItemsUploaded || event === SyncEvent.LocalDataIncrementalLoad) {
        void this.reload().catch(console.error)
      }
    })
  }

  override deinit(): void {
    this.deinitialized = true
    this.appearanceWriteScheduled = false
    this.removeItemObserver?.()
    this.removeSyncObserver?.()
    ;(this.singletons as unknown) = undefined
    ;(this.mutator as unknown) = undefined

    super.deinit()
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.PreparingForSignOut) {
      const { phase } = event.payload as PreparingForSignOutEventPayload
      if (phase === 'cancel') {
        this.appearanceWritesFenced = false
        return
      }

      if (phase === 'commit') {
        /** No appearance mutation may begin after this final pre-clear barrier. */
        this.appearanceWritesFenced = true
      }

      await this.drainAppearanceWrites()
      return
    }

    if (event.type === ApplicationEvent.ApplicationStageChanged) {
      const stage = (event.payload as ApplicationStageChangedEventPayload).stage
      if (stage === ApplicationStage.LoadedDatabase_12) {
        /** Try to read preferences singleton from storage */
        this.preferences = this.singletons.findSingleton<SNUserPrefs>(
          ContentType.TYPES.UserPrefs,
          SNUserPrefs.singletonPredicate,
        )

        if (this.preferences) {
          await this.reconcileAppearancePreference(false)
          void this.notifyEvent(PreferencesServiceEvent.PreferencesChanged)
        }
      } else if (stage === ApplicationStage.StorageDecrypted_09) {
        this.localPreferences = this.storage.getValue(StorageKey.LocalPreferences) ?? {}
        void this.notifyEvent(PreferencesServiceEvent.LocalPreferencesChanged)
      } else if (stage === ApplicationStage.FullSyncCompleted_13) {
        await this.reload()
        await this.reconcileAppearancePreference(true)
      }
    }
  }

  getLocalValue<K extends LocalPrefKey>(
    key: K,
    defaultValue: LocalPrefValue[K] | undefined,
  ): LocalPrefValue[K] | undefined
  getLocalValue<K extends LocalPrefKey>(key: K, defaultValue: LocalPrefValue[K]): LocalPrefValue[K]
  getLocalValue<K extends LocalPrefKey>(key: K, defaultValue?: LocalPrefValue[K]): LocalPrefValue[K] | undefined {
    return this.localPreferences[key] ?? defaultValue
  }

  getValue<K extends PrefKey>(key: K, defaultValue: PrefValue[K] | undefined): PrefValue[K] | undefined
  getValue<K extends PrefKey>(key: K, defaultValue: PrefValue[K]): PrefValue[K]
  getValue<K extends PrefKey>(key: K, defaultValue?: PrefValue[K]): PrefValue[K] | undefined {
    return this.preferences?.getPref(key) ?? defaultValue
  }

  setLocalValue<K extends LocalPrefKey>(
    key: K,
    value: LocalPrefValue[K],
    options: LocalPreferenceWriteOptions = {},
  ): void {
    const isAppearanceInput = key === LocalPrefKey.ColorSchemeMode || key === LocalPrefKey.ActiveThemes
    if (this.deinitialized || (isAppearanceInput && this.appearanceWritesFenced)) {
      return
    }

    const previousAppearance = isAppearanceInput ? this.createAppearancePreferenceFromLocal() : undefined

    this.localPreferences[key] = value

    const nextAppearance = isAppearanceInput ? this.createAppearancePreferenceFromLocal() : undefined
    const shouldSyncAppearance =
      options.source !== 'implicit' &&
      previousAppearance !== undefined &&
      nextAppearance !== undefined &&
      !this.appearancePreferencesEqual(previousAppearance, nextAppearance)

    if (shouldSyncAppearance) {
      this.appearanceExplicitlyDirty = true
      this.scheduleAppearancePreferenceWrite()
    }

    this.storage.setValue(StorageKey.LocalPreferences, this.localPreferences)

    void this.notifyEvent(PreferencesServiceEvent.LocalPreferencesChanged)
  }

  async setValue<K extends PrefKey>(key: K, value: PrefValue[K]): Promise<void> {
    if (this.deinitialized) {
      return
    }

    await this.setValueDetached(key, value)

    if (this.deinitialized) {
      return
    }

    void this.notifyEvent(PreferencesServiceEvent.PreferencesChanged)

    void this.sync.sync({ sourceDescription: 'PreferencesService.setValue' })
  }

  async setValueDetached<K extends PrefKey>(key: K, value: PrefValue[K]): Promise<void> {
    if (this.deinitialized || !this.preferences) {
      return
    }

    this.preferences = (await this.mutator.changeItem<UserPrefsMutator>(this.preferences, (m) => {
      m.setPref(key, value)
    })) as SNUserPrefs
  }

  private async reload(): Promise<void> {
    if (!this.shouldReload) {
      return
    }

    if (this.reloading) {
      await this.reloadPromise
      return
    }

    this.reloading = true
    this.reloadPromise = this.performReload()

    try {
      await this.reloadPromise
    } finally {
      this.reloading = false
      this.reloadPromise = undefined
    }
  }

  private async performReload(): Promise<void> {
    const previousRef = this.preferences

    this.preferences = await this.singletons.findOrCreateContentTypeSingleton<ItemContent, SNUserPrefs>(
      ContentType.TYPES.UserPrefs,
      FillItemContent({}),
    )

    if (
      previousRef?.uuid !== this.preferences.uuid ||
      this.preferences.userModifiedDate > previousRef.userModifiedDate
    ) {
      void this.notifyEvent(PreferencesServiceEvent.PreferencesChanged)
    }

    await this.reconcileAppearancePreference(false)
    this.shouldReload = false
  }

  private scheduleAppearancePreferenceWrite(): void {
    if (this.deinitialized || this.appearanceWriteScheduled) {
      return
    }

    this.appearanceWriteScheduled = true
    const criticalWrite = this.executeCriticalFunction(async () => {
      try {
        /** Coalesce the add-new/remove-old theme transition into one snapshot. */
        await Promise.resolve()
        if (this.deinitialized) {
          return
        }

        this.appearanceWriteScheduled = false
        await this.queueAppearancePreferenceWrite(this.createAppearancePreferenceFromLocal())
      } catch (error) {
        console.error(error)
      } finally {
        this.appearanceWriteScheduled = false
      }
    })
    this.appearanceCriticalWrite = criticalWrite
    void criticalWrite.then(() => {
      if (this.appearanceCriticalWrite === criticalWrite) {
        this.appearanceCriticalWrite = undefined
      }
    })
  }

  private async drainAppearanceWrites(): Promise<void> {
    let observedCriticalWrite: Promise<void> | undefined
    let observedWriteQueue: Promise<void>
    do {
      observedCriticalWrite = this.appearanceCriticalWrite
      observedWriteQueue = this.appearanceWriteQueue
      await observedCriticalWrite
      await observedWriteQueue
    } while (this.appearanceCriticalWrite !== observedCriticalWrite || this.appearanceWriteQueue !== observedWriteQueue)
  }

  private queueAppearancePreferenceWrite(appearance: UserAppearancePreference): Promise<void> {
    const canonicalAppearance = this.canonicalizeAppearancePreference(appearance)
    const write = this.appearanceWriteQueue.then(async () => {
      if (this.deinitialized || !this.preferences) {
        return
      }

      const rawCurrent = this.preferences.getPref(PrefKey.UserAppearance) as unknown
      if (isFutureUserAppearancePreference(rawCurrent)) {
        return
      }

      const normalizedCurrent = normalizeUserAppearancePreference(rawCurrent)
      const current = normalizedCurrent ? this.canonicalizeAppearancePreference(normalizedCurrent) : undefined
      const alreadyMatches = this.appearancePreferencesEqual(current, canonicalAppearance)
      const currentIsCanonical = this.isRawAppearanceCanonical(rawCurrent, current)
      if (!alreadyMatches || !currentIsCanonical) {
        await this.setValue(PrefKey.UserAppearance, canonicalAppearance)
      }

      /**
       * A mutation is only optimistic until a later reload observes the same
       * value. Keep the dirty guard armed after writing so a racing stale sync
       * response cannot replace the user's newer same-launch choice.
       */
      if (
        alreadyMatches &&
        currentIsCanonical &&
        this.appearancePreferencesEqual(this.createAppearancePreferenceFromLocal(), canonicalAppearance)
      ) {
        this.appearanceExplicitlyDirty = false
      }
    })

    this.appearanceWriteQueue = write.catch(() => undefined)
    return write
  }

  private async reconcileAppearancePreference(allowLocalBootstrap: boolean): Promise<void> {
    if (!this.preferences) {
      return
    }

    const rawSyncedAppearance = this.preferences.getPref(PrefKey.UserAppearance) as unknown
    const normalizedSyncedAppearance = normalizeUserAppearancePreference(rawSyncedAppearance)
    const syncedAppearance = normalizedSyncedAppearance
      ? this.canonicalizeAppearancePreference(normalizedSyncedAppearance)
      : undefined

    if (syncedAppearance) {
      const localAppearance = this.createAppearancePreferenceFromLocal()

      if (this.appearanceExplicitlyDirty && !this.appearancePreferencesEqual(localAppearance, syncedAppearance)) {
        await this.queueAppearancePreferenceWrite(localAppearance)
        return
      }

      this.appearanceExplicitlyDirty = false
      if (allowLocalBootstrap && !this.isRawAppearanceCanonical(rawSyncedAppearance, syncedAppearance)) {
        await this.queueAppearancePreferenceWrite(syncedAppearance)
      }
      await this.applyAppearancePreferenceToLocal(syncedAppearance)
      return
    }

    /** Never overwrite an unknown/future schema with this client's v1 shape. */
    if (isFutureUserAppearancePreference(rawSyncedAppearance) || !allowLocalBootstrap) {
      return
    }

    const localAppearance = this.createAppearancePreferenceFromLocal()
    const legacySyncedAppearance = this.createAppearancePreferenceFromLegacySyncedPreferences()
    const appearanceToPersist = this.appearanceExplicitlyDirty
      ? localAppearance
      : (legacySyncedAppearance ??
        (rawSyncedAppearance !== undefined || this.hasStoredLocalAppearance() ? localAppearance : undefined))

    if (!appearanceToPersist) {
      return
    }

    await this.queueAppearancePreferenceWrite(appearanceToPersist)
    await this.applyAppearancePreferenceToLocal(appearanceToPersist)
  }

  private createAppearancePreferenceFromLocal(): UserAppearancePreference {
    const storedMode =
      this.getLocalValue(LocalPrefKey.ColorSchemeMode, LocalPrefDefaults[LocalPrefKey.ColorSchemeMode]) ?? 'dark'
    const useLegacySystemColorScheme = this.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)
    const colorSchemeMode: ColorSchemeMode = useLegacySystemColorScheme ? 'auto' : storedMode
    const activeThemes = this.getLocalValue(LocalPrefKey.ActiveThemes, []) ?? []

    return this.canonicalizeAppearancePreference({
      version: CurrentUserAppearancePreferenceVersion,
      colorSchemeMode,
      activeThemes,
    })
  }

  private async applyAppearancePreferenceToLocal(appearance: UserAppearancePreference): Promise<void> {
    appearance = this.canonicalizeAppearancePreference(appearance)
    const currentAppearance = this.createAppearancePreferenceFromLocal()
    const hasCurrentVersion =
      this.getLocalValue(LocalPrefKey.ColorSchemeModeVersion, undefined) === CurrentColorSchemeModeVersion
    const legacySystemColorSchemeEnabled = this.getLocalValue(LocalPrefKey.UseSystemColorScheme, false)

    if (
      this.appearancePreferencesEqual(currentAppearance, appearance) &&
      hasCurrentVersion &&
      !legacySystemColorSchemeEnabled
    ) {
      return
    }

    this.localPreferences[LocalPrefKey.ColorSchemeMode] = appearance.colorSchemeMode
    this.localPreferences[LocalPrefKey.ColorSchemeModeVersion] = CurrentColorSchemeModeVersion
    this.localPreferences[LocalPrefKey.ActiveThemes] = appearance.activeThemes.slice()
    this.localPreferences[LocalPrefKey.UseSystemColorScheme] = false
    this.storage.setValue(StorageKey.LocalPreferences, this.localPreferences)

    await this.notifyEvent(PreferencesServiceEvent.LocalPreferencesChanged)
  }

  private hasStoredLocalAppearance(): boolean {
    return (
      Object.prototype.hasOwnProperty.call(this.localPreferences, LocalPrefKey.ColorSchemeMode) ||
      Object.prototype.hasOwnProperty.call(this.localPreferences, LocalPrefKey.ColorSchemeModeVersion) ||
      Object.prototype.hasOwnProperty.call(this.localPreferences, LocalPrefKey.ActiveThemes) ||
      Object.prototype.hasOwnProperty.call(this.localPreferences, LocalPrefKey.UseSystemColorScheme)
    )
  }

  private createAppearancePreferenceFromLegacySyncedPreferences(): UserAppearancePreference | undefined {
    if (!this.preferences) {
      return undefined
    }

    const rawActiveThemes = this.preferences.getPref(PrefKey.DEPRECATED_ActiveThemes) as unknown
    const rawUseSystemColorScheme = this.preferences.getPref(PrefKey.DEPRECATED_UseSystemColorScheme) as unknown
    if (rawActiveThemes === undefined && rawUseSystemColorScheme === undefined) {
      return undefined
    }

    const normalized = normalizeUserAppearancePreference({
      version: CurrentUserAppearancePreferenceVersion,
      colorSchemeMode: rawUseSystemColorScheme === true ? 'auto' : 'manual',
      activeThemes: Array.isArray(rawActiveThemes) ? rawActiveThemes : [],
    }) as UserAppearancePreference

    if (rawUseSystemColorScheme !== true && normalized.activeThemes.length === 0) {
      normalized.colorSchemeMode = 'dark'
    }

    return this.canonicalizeAppearancePreference(normalized)
  }

  /**
   * ActiveThemes can briefly contain old+new bases while ComponentManager avoids
   * a visual flicker. Persist only the final base (the newly appended entry),
   * while retaining layerable and unknown theme identifiers. Automatic modes
   * own their base, so their known base identifiers are device-runtime state.
   */
  private canonicalizeAppearancePreference(appearance: UserAppearancePreference): UserAppearancePreference {
    const normalized = normalizeUserAppearancePreference(appearance) as UserAppearancePreference
    let selectedBaseTheme: string | undefined
    const otherThemes: string[] = []

    for (const identifier of normalized.activeThemes) {
      if (this.isNonLayerableThemeIdentifier(identifier)) {
        selectedBaseTheme = identifier
      } else {
        otherThemes.push(identifier)
      }
    }

    return {
      ...normalized,
      activeThemes:
        normalized.colorSchemeMode === 'manual' && selectedBaseTheme
          ? [selectedBaseTheme, ...otherThemes]
          : otherThemes,
    }
  }

  private isNonLayerableThemeIdentifier(identifier: string): boolean {
    const nativeTheme = FindNativeTheme(identifier)
    if (nativeTheme) {
      return !nativeTheme.layerable
    }

    const component = this.items.findItem<ComponentInterface>(identifier)
    return component?.isTheme() === true && !component.layerableTheme
  }

  private isRawAppearanceCanonical(
    rawAppearance: unknown,
    normalizedAppearance: UserAppearancePreference | undefined,
  ): boolean {
    if (typeof rawAppearance !== 'object' || rawAppearance === null || !normalizedAppearance) {
      return false
    }

    const candidate = rawAppearance as Partial<UserAppearancePreference>
    return (
      candidate.version === normalizedAppearance.version &&
      candidate.colorSchemeMode === normalizedAppearance.colorSchemeMode &&
      Array.isArray(candidate.activeThemes) &&
      candidate.activeThemes.length === normalizedAppearance.activeThemes.length &&
      candidate.activeThemes.every((identifier, index) => identifier === normalizedAppearance.activeThemes[index])
    )
  }

  private appearancePreferencesEqual(
    left: UserAppearancePreference | undefined,
    right: UserAppearancePreference,
  ): boolean {
    return (
      left?.version === right.version &&
      left.colorSchemeMode === right.colorSchemeMode &&
      left.activeThemes.length === right.activeThemes.length &&
      left.activeThemes.every((identifier, index) => identifier === right.activeThemes[index])
    )
  }
}
