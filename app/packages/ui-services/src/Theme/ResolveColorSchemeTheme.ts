import { NativeFeatureIdentifier } from '@standardnotes/features'
import { ColorSchemeMode } from '@standardnotes/services'

/** Standard Red Notes' complete, first-class dark base theme. */
export const StandardRedThemeIdentifier = NativeFeatureIdentifier.TYPES.StandardRedTheme

/**
 * Standard Red Notes: identifier for the light theme, "Standard Notes Blue".
 */
export const StandardBlueThemeIdentifier = NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme

/**
 * Pure resolution of the active theme identifier for a given color-scheme mode.
 *
 * Mapping for this fork:
 * - `manual` -> no automatic theme (preserve the explicitly selected theme)
 * - `light`  -> Standard Blue (light theme)
 * - `dark`   -> Standard Red (default/dark theme)
 * - `auto`   -> follows the OS: dark -> Standard Red, light -> Standard Blue.
 *
 * `systemPrefersDark` is the result of `window.matchMedia('(prefers-color-scheme: dark)').matches`
 * (or the native equivalent). When the OS preference is indeterminate (`undefined`),
 * Auto falls back to dark (Standard Red).
 */
export function resolveColorSchemeTheme(
  mode: ColorSchemeMode,
  systemPrefersDark: boolean | undefined,
): string | undefined {
  if (mode === 'manual') {
    return undefined
  }

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
