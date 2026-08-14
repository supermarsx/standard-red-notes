import { ColorSchemeMode, ThemeFeatureDescription, UIFeature } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  applyCustomThemeFromState,
  loadCustomThemesState,
  migrateLegacyCustomThemes,
  removeCustomThemeOverride,
  saveCustomThemesState,
} from './CustomThemes/CustomThemeManager'
import { CustomThemesState } from './CustomThemes/CustomTheme'

export const STANDARD_RED_SWATCH = '#e85f6d'

export function hasSelectedCustomTheme(application: WebApplication): boolean {
  return loadCustomThemesState(application.preferences).selectedId !== null
}

export function persistAndApplyCustomThemesState(
  application: WebApplication,
  state: CustomThemesState,
): CustomThemesState {
  if (state.selectedId !== null) {
    application.themeManager.setColorSchemeMode('manual')
  }

  const saved = saveCustomThemesState(application.preferences, state)
  applyCustomThemeFromState(saved)
  return saved
}

export function selectCustomTheme(application: WebApplication, selectedId: string): boolean {
  const current = migrateLegacyCustomThemes(application.preferences)
  if (!current.themes.some((theme) => theme.id === selectedId)) {
    return false
  }

  persistAndApplyCustomThemesState(application, { ...current, selectedId })
  return true
}

function clearCustomThemeSelection(application: WebApplication): void {
  const current = migrateLegacyCustomThemes(application.preferences)
  if (current.selectedId !== null) {
    saveCustomThemesState(application.preferences, { ...current, selectedId: null })
  }
  removeCustomThemeOverride()
}

/**
 * Changes automatic/base color-scheme ownership without leaving a custom CSS
 * override above the selected built-in theme. Manual mode deliberately keeps
 * the current custom choice because custom themes themselves use Manual mode.
 */
export function selectColorSchemeMode(application: WebApplication, mode: ColorSchemeMode): void {
  if (mode !== 'manual') {
    clearCustomThemeSelection(application)
  }
  application.themeManager.setColorSchemeMode(mode)
}

/**
 * The one web-side boundary for built-in selection. It clears and persists the
 * current custom choice before ThemeManager changes ActiveThemes, preventing a
 * stale CSS override from making the saved built-in theme appear ineffective.
 */
export async function selectBuiltInTheme(
  application: WebApplication,
  theme?: UIFeature<ThemeFeatureDescription>,
  options: { toggleActive?: boolean } = {},
): Promise<void> {
  clearCustomThemeSelection(application)

  if (theme) {
    if (!options.toggleActive && !theme.layerable && application.componentManager.isThemeActive(theme)) {
      // The theme was already underneath a custom override. Clearing that
      // override is the whole selection; toggling would incorrectly turn the
      // requested theme off.
      application.themeManager.setColorSchemeMode('manual')
      return
    }
    await application.themeManager.selectTheme(theme)
  } else {
    await application.themeManager.selectDefaultTheme()
  }
}
