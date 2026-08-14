import { LocalPrefKey, ApplicationStage, ColorSchemeMode, CurrentColorSchemeModeVersion } from '@standardnotes/services'
import { Migration } from '@Lib/Migrations/Migration'
import { CurrentUserAppearancePreferenceVersion, PrefDefaults, PrefKey } from '@standardnotes/models'

export class Migration2_208_0 extends Migration {
  static override version(): string {
    return '2.208.0'
  }

  protected registerStageHandlers(): void {
    this.registerStageHandler(ApplicationStage.FullSyncCompleted_13, async () => {
      await this.migrateSyncedPreferencesToLocal()

      this.markDone()
    })
  }

  private async migrateSyncedPreferencesToLocal(): Promise<void> {
    await this.migrateAppearancePreferences()

    if (this.services.preferences.getLocalValue(LocalPrefKey.UseTranslucentUI, undefined) === undefined) {
      this.services.preferences.setLocalValue(
        LocalPrefKey.UseTranslucentUI,
        this.services.preferences.getValue(
          PrefKey.DEPRECATED_UseTranslucentUI,
          PrefDefaults[PrefKey.DEPRECATED_UseTranslucentUI],
        ),
      )
    }
  }

  private async migrateAppearancePreferences(): Promise<void> {
    const syncedAppearance = this.services.preferences.getValue(PrefKey.UserAppearance, undefined) as unknown
    if (syncedAppearance !== undefined) {
      return
    }

    const deprecatedActiveThemes = this.services.preferences.getValue(PrefKey.DEPRECATED_ActiveThemes, undefined)
    const deprecatedUseSystemColorScheme = this.services.preferences.getValue(
      PrefKey.DEPRECATED_UseSystemColorScheme,
      undefined,
    )
    const hasDeprecatedSyncedAppearance =
      deprecatedActiveThemes !== undefined || deprecatedUseSystemColorScheme !== undefined

    /**
     * The launch-time local mode migration runs before database/full-sync
     * migrations. Synced legacy values therefore outrank that implicit cache;
     * PreferencesService still lets a genuinely explicit same-launch choice
     * overwrite this value using its in-memory provenance guard.
     */
    if (hasDeprecatedSyncedAppearance) {
      const activeThemes = deprecatedActiveThemes ?? PrefDefaults[PrefKey.DEPRECATED_ActiveThemes]
      const useSystemColorScheme =
        deprecatedUseSystemColorScheme ?? PrefDefaults[PrefKey.DEPRECATED_UseSystemColorScheme]

      this.services.preferences.setLocalValue(LocalPrefKey.ActiveThemes, activeThemes, { source: 'implicit' })
      this.services.preferences.setLocalValue(LocalPrefKey.UseSystemColorScheme, useSystemColorScheme)
      this.services.preferences.setLocalValue(
        LocalPrefKey.AutoLightThemeIdentifier,
        this.services.preferences.getValue(
          PrefKey.DEPRECATED_AutoLightThemeIdentifier,
          PrefDefaults[PrefKey.DEPRECATED_AutoLightThemeIdentifier],
        ),
      )
      this.services.preferences.setLocalValue(
        LocalPrefKey.AutoDarkThemeIdentifier,
        this.services.preferences.getValue(
          PrefKey.DEPRECATED_AutoDarkThemeIdentifier,
          PrefDefaults[PrefKey.DEPRECATED_AutoDarkThemeIdentifier],
        ),
      )

      const colorSchemeMode: ColorSchemeMode = useSystemColorScheme
        ? 'auto'
        : activeThemes.length > 0
          ? 'manual'
          : 'dark'

      await this.services.preferences.setValueDetached(PrefKey.UserAppearance, {
        version: CurrentUserAppearancePreferenceVersion,
        colorSchemeMode,
        activeThemes: [...new Set(activeThemes)],
      })

      this.services.preferences.setLocalValue(LocalPrefKey.ColorSchemeModeVersion, CurrentColorSchemeModeVersion)
      this.services.preferences.setLocalValue(LocalPrefKey.ColorSchemeMode, colorSchemeMode, { source: 'implicit' })
      return
    }

    const localMode = this.services.preferences.getLocalValue(LocalPrefKey.ColorSchemeMode, undefined)
    const localModeVersion = this.services.preferences.getLocalValue(LocalPrefKey.ColorSchemeModeVersion, undefined)
    const localActiveThemes = this.services.preferences.getLocalValue(LocalPrefKey.ActiveThemes, undefined)
    const hasNewLocalAppearance =
      localMode !== undefined || localModeVersion !== undefined || localActiveThemes !== undefined

    if (hasNewLocalAppearance) {
      const useLegacySystemColorScheme = this.services.preferences.getLocalValue(
        LocalPrefKey.UseSystemColorScheme,
        false,
      )
      const colorSchemeMode: ColorSchemeMode = useLegacySystemColorScheme
        ? 'auto'
        : (localMode ?? (localActiveThemes && localActiveThemes.length > 0 ? 'manual' : 'dark'))

      await this.services.preferences.setValueDetached(PrefKey.UserAppearance, {
        version: CurrentUserAppearancePreferenceVersion,
        colorSchemeMode,
        activeThemes: [...new Set(localActiveThemes ?? [])],
      })
      return
    }
  }
}
