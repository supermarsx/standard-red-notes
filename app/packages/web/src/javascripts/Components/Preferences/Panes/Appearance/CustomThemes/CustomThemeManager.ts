/*
 * Standard Red Notes — custom-theme persistence and runtime application.
 *
 * Custom themes live in LocalPrefKey.CustomThemes, which is encrypted and
 * namespaced by the current application/workspace. The old origin-global
 * localStorage value is read at most once for the current workspace and then
 * removed so it cannot bleed into another account.
 */

import { ApplicationEvent, LocalPrefKey, PreferenceServiceInterface } from '@standardnotes/snjs'
import { CustomTheme, CustomThemesState, buildCustomThemeCss, normalizeCustomThemeList } from './CustomTheme'

export const LEGACY_CUSTOM_THEMES_STORAGE_KEY = 'sn-custom-themes'
export const CUSTOM_THEME_STYLE_ELEMENT_ID = 'sn-custom-theme'

const EmptyCustomThemesState: CustomThemesState = { themes: [], selectedId: null }

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>

function emptyState(): CustomThemesState {
  return { themes: [], selectedId: null }
}

export function normalizeCustomThemesState(input: unknown): CustomThemesState {
  if (typeof input !== 'object' || input === null) {
    return emptyState()
  }

  const candidate = input as Partial<CustomThemesState>
  const themes = normalizeCustomThemeList(candidate.themes)
  const selectedId =
    typeof candidate.selectedId === 'string' && themes.some((theme) => theme.id === candidate.selectedId)
      ? candidate.selectedId
      : null

  return { themes, selectedId }
}

export function loadCustomThemesState(preferences: PreferenceServiceInterface): CustomThemesState {
  const stored = preferences.getLocalValue(LocalPrefKey.CustomThemes, EmptyCustomThemesState)
  return normalizeCustomThemesState(stored)
}

export function saveCustomThemesState(
  preferences: PreferenceServiceInterface,
  state: CustomThemesState,
): CustomThemesState {
  const normalized = normalizeCustomThemesState(state)
  preferences.setLocalValue(LocalPrefKey.CustomThemes, normalized)
  return normalized
}

function browserLegacyStorage(): LegacyStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function removeLegacyValue(storage: LegacyStorage | undefined): void {
  try {
    storage?.removeItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)
  } catch (error) {
    console.error('[CustomThemes] Failed to remove legacy state', error)
  }
}

/**
 * Transfers the legacy origin-global value once. Persisting an empty state also
 * acts as the migration marker when there was no usable legacy value.
 */
export function migrateLegacyCustomThemes(
  preferences: PreferenceServiceInterface,
  legacyStorage: LegacyStorage | undefined = browserLegacyStorage(),
): CustomThemesState {
  const existing = preferences.getLocalValue(LocalPrefKey.CustomThemes, undefined)
  if (existing !== undefined) {
    removeLegacyValue(legacyStorage)
    return normalizeCustomThemesState(existing)
  }

  let migrated = emptyState()
  try {
    const raw = legacyStorage?.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY)
    if (raw) {
      migrated = normalizeCustomThemesState(JSON.parse(raw) as unknown)
    }
  } catch (error) {
    console.error('[CustomThemes] Failed to migrate legacy state', error)
  }

  saveCustomThemesState(preferences, migrated)
  removeLegacyValue(legacyStorage)
  return migrated
}

function getOrCreateStyleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  let element = document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = CUSTOM_THEME_STYLE_ELEMENT_ID
    element.setAttribute('type', 'text/css')
    document.head.appendChild(element)
  }
  return element
}

/** Removes the current workspace's override before another base theme/account is shown. */
export function removeCustomThemeOverride(): void {
  if (typeof document === 'undefined') {
    return
  }
  document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID)?.remove()
}

/** Injects (or replaces) the single current-account custom theme override. */
export function applyCustomThemeOverride(theme: CustomTheme): void {
  const element = getOrCreateStyleElement()
  if (!element) {
    return
  }

  // Re-append after any newly activated base theme link so this override wins.
  document.head.appendChild(element)
  element.textContent = buildCustomThemeCss(theme.colors)
}

export function applyCustomThemeFromState(state: CustomThemesState): void {
  const normalized = normalizeCustomThemesState(state)
  const theme = normalized.themes.find((candidate) => candidate.id === normalized.selectedId)
  if (!theme) {
    removeCustomThemeOverride()
    return
  }

  applyCustomThemeOverride(theme)
}

export function applyCurrentAccountCustomTheme(preferences: PreferenceServiceInterface): void {
  applyCustomThemeFromState(loadCustomThemesState(preferences))
}

export function initializeCurrentAccountCustomTheme(preferences: PreferenceServiceInterface): void {
  applyCustomThemeFromState(migrateLegacyCustomThemes(preferences))
}

/** Pure lifecycle boundary used by ApplicationView and directly regression-tested. */
export function handleCustomThemeApplicationEvent(
  preferences: PreferenceServiceInterface,
  event: ApplicationEvent,
): void {
  if (event === ApplicationEvent.SignedOut) {
    removeCustomThemeOverride()
  } else if (event === ApplicationEvent.Launched) {
    initializeCurrentAccountCustomTheme(preferences)
  } else if (event === ApplicationEvent.LocalPreferencesChanged) {
    applyCurrentAccountCustomTheme(preferences)
  }
}
