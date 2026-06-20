/*
 * Standard Red Notes — Custom Themes runtime + storage (web-only)
 *
 * Persists user-created custom themes in localStorage and applies the selected
 * one live by injecting a single `<style id="sn-custom-theme">` element holding
 * a `:root { --sn-stylekit-*: ... }` override. This layers on top of whatever
 * base light/dark theme is active. Selecting a built-in theme (selectedId null)
 * removes the style element, cleanly restoring the base look.
 *
 * Stored as plain localStorage JSON so there is zero edit to the published
 * `@standardnotes/models` PrefKey enum (mirrors the email-backup / large-file /
 * local-pref web-only precedent).
 */

import { CustomTheme, CustomThemesState, buildCustomThemeCss, normalizeCustomThemeList } from './CustomTheme'

const STORAGE_KEY = 'sn-custom-themes'
const STYLE_ELEMENT_ID = 'sn-custom-theme'

type PersistedShape = {
  themes: CustomTheme[]
  selectedId: string | null
}

export function loadCustomThemesState(): CustomThemesState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) {
      return { themes: [], selectedId: null }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedShape>
    const themes = normalizeCustomThemeList(parsed.themes)
    const selectedId =
      typeof parsed.selectedId === 'string' && themes.some((theme) => theme.id === parsed.selectedId)
        ? parsed.selectedId
        : null
    return { themes, selectedId }
  } catch (error) {
    console.error('[CustomThemes] Failed to load state', error)
    return { themes: [], selectedId: null }
  }
}

export function saveCustomThemesState(state: CustomThemesState): void {
  try {
    if (typeof localStorage === 'undefined') {
      return
    }
    const payload: PersistedShape = { themes: state.themes, selectedId: state.selectedId }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.error('[CustomThemes] Failed to save state', error)
  }
}

function getOrCreateStyleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') {
    return null
  }
  let element = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = STYLE_ELEMENT_ID
    element.setAttribute('type', 'text/css')
    document.head.appendChild(element)
  }
  return element
}

/** Removes the injected custom-theme override, restoring the base theme. */
export function removeCustomThemeOverride(): void {
  if (typeof document === 'undefined') {
    return
  }
  const element = document.getElementById(STYLE_ELEMENT_ID)
  element?.parentNode?.removeChild(element)
}

/** Injects (or replaces) the `:root` override for a single custom theme. */
export function applyCustomThemeOverride(theme: CustomTheme): void {
  const element = getOrCreateStyleElement()
  if (!element) {
    return
  }
  // Keep the style element last in <head> so it wins over base theme <link>s
  // that may be (re)appended when the base light/dark theme switches.
  document.head.appendChild(element)
  element.textContent = buildCustomThemeCss(theme.colors)
}

/**
 * Applies whatever the current selection in `state` dictates: the selected
 * custom theme's override, or removes the override when none is selected.
 */
export function applyCustomThemeFromState(state: CustomThemesState): void {
  if (!state.selectedId) {
    removeCustomThemeOverride()
    return
  }
  const theme = state.themes.find((candidate) => candidate.id === state.selectedId)
  if (!theme) {
    removeCustomThemeOverride()
    return
  }
  applyCustomThemeOverride(theme)
}

/**
 * Re-applies the persisted selection from localStorage. Safe to call on app
 * load and after the base theme switches (auto light/dark), since it re-asserts
 * the override on top of the freshly applied base theme.
 */
export function reapplyPersistedCustomTheme(): void {
  applyCustomThemeFromState(loadCustomThemesState())
}
