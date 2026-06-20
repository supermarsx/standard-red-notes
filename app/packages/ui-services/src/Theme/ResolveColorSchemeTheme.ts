import { NativeFeatureIdentifier } from '@standardnotes/features'
import { ColorSchemeMode } from '@standardnotes/services'

/**
 * Standard Red Notes: identifier representing the fork's default/dark base look,
 * "Standard Red". It is applied by deactivating any active non-layerable theme
 * (the base styles are the Standard Red look), hence the special `Default` value
 * already used by the auto-theme machinery.
 */
export const StandardRedThemeIdentifier = 'Default'

/**
 * Standard Red Notes: identifier for the light theme, "Standard Notes Blue".
 */
export const StandardBlueThemeIdentifier = NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme

/**
 * Pure resolution of the active theme identifier for a given color-scheme mode.
 *
 * Mapping for this fork:
 * - `light`  -> Standard Blue (light theme)
 * - `dark`   -> Standard Red (default/dark theme)
 * - `auto`   -> follows the OS: dark -> Standard Red, light -> Standard Blue.
 *
 * `systemPrefersDark` is the result of `window.matchMedia('(prefers-color-scheme: dark)').matches`
 * (or the native equivalent). When the OS preference is indeterminate (`undefined`),
 * Auto falls back to dark (Standard Red).
 */
export function resolveColorSchemeTheme(mode: ColorSchemeMode, systemPrefersDark: boolean | undefined): string {
  if (mode === 'light') {
    return StandardBlueThemeIdentifier
  }

  if (mode === 'dark') {
    return StandardRedThemeIdentifier
  }

  // mode === 'auto': follow the OS, defaulting to dark when indeterminate.
  const prefersDark = systemPrefersDark ?? true
  return prefersDark ? StandardRedThemeIdentifier : StandardBlueThemeIdentifier
}
