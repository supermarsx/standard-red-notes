import { EditorFontSize, EditorLineHeight, EditorLineWidth } from '@standardnotes/models'
import { NativeFeatureIdentifier } from '@standardnotes/features'

/**
 * Standard Red Notes: the user-facing automatic light/dark color-scheme mode.
 * - `auto` follows the operating-system color scheme live (dark -> Standard Red,
 *   light -> Standard Blue), falling back to dark (Standard Red) when the OS
 *   preference can't be determined.
 * - `light` always forces the light theme (Standard Blue).
 * - `dark` always forces the dark/default theme (Standard Red).
 */
export type ColorSchemeMode = 'auto' | 'light' | 'dark'

export enum LocalPrefKey {
  ListPaneCollapsed = 'listPaneCollapsed',
  NavigationPaneCollapsed = 'navigationPaneCollapsed',
  ActiveThemes = 'activeThemes',
  UseSystemColorScheme = 'useSystemColorScheme',
  UseTranslucentUI = 'useTranslucentUI',
  AutoLightThemeIdentifier = 'autoLightThemeIdentifier',
  AutoDarkThemeIdentifier = 'autoDarkThemeIdentifier',
  // Standard Red Notes: the auto/light/dark color-scheme selector. `auto` follows
  // the OS color scheme; `light`/`dark` force Standard Blue / Standard Red.
  ColorSchemeMode = 'colorSchemeMode',

  EditorMonospaceEnabled = 'monospaceFont',
  EditorLineHeight = 'editorLineHeight',
  EditorLineWidth = 'editorLineWidth',
  EditorFontSize = 'editorFontSize',
  // Standard Red Notes: enables OpenType ligatures (common + contextual, plus
  // coding ligatures for monospace) across the editors. Web-only, stored
  // locally to avoid touching the published @standardnotes/models package.
  EditorLigaturesEnabled = 'editorLigaturesEnabled',
}

export type LocalPrefValue = {
  [LocalPrefKey.ListPaneCollapsed]: boolean
  [LocalPrefKey.NavigationPaneCollapsed]: boolean
  [LocalPrefKey.ActiveThemes]: string[]
  [LocalPrefKey.UseSystemColorScheme]: boolean
  [LocalPrefKey.UseTranslucentUI]: boolean
  [LocalPrefKey.AutoLightThemeIdentifier]: string
  [LocalPrefKey.AutoDarkThemeIdentifier]: string
  [LocalPrefKey.ColorSchemeMode]: ColorSchemeMode

  [LocalPrefKey.EditorMonospaceEnabled]: boolean
  [LocalPrefKey.EditorLineHeight]: EditorLineHeight
  [LocalPrefKey.EditorLineWidth]: EditorLineWidth
  [LocalPrefKey.EditorFontSize]: EditorFontSize
  [LocalPrefKey.EditorLigaturesEnabled]: boolean
}

export const LocalPrefDefaults = {
  [LocalPrefKey.ListPaneCollapsed]: false,
  [LocalPrefKey.NavigationPaneCollapsed]: false,
  [LocalPrefKey.ActiveThemes]: [],
  [LocalPrefKey.UseSystemColorScheme]: false,
  [LocalPrefKey.UseTranslucentUI]: true,
  [LocalPrefKey.AutoLightThemeIdentifier]: 'Default',
  [LocalPrefKey.AutoDarkThemeIdentifier]: NativeFeatureIdentifier.TYPES.DarkTheme,
  // Standard Red Notes: default to Auto so the app follows the OS color scheme
  // out of the box (dark -> Standard Red, light -> Standard Blue).
  [LocalPrefKey.ColorSchemeMode]: 'auto',

  [LocalPrefKey.EditorMonospaceEnabled]: false,
  [LocalPrefKey.EditorLineHeight]: EditorLineHeight.Normal,
  [LocalPrefKey.EditorLineWidth]: EditorLineWidth.FullWidth,
  [LocalPrefKey.EditorFontSize]: EditorFontSize.Normal,
  // Default OFF: ligatures change text rendering, so they're opt-in.
  [LocalPrefKey.EditorLigaturesEnabled]: false,
} satisfies {
  [key in LocalPrefKey]: LocalPrefValue[key]
}
