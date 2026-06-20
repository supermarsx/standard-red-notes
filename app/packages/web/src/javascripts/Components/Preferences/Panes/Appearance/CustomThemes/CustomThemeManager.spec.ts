/**
 * @jest-environment jsdom
 */
import { CustomTheme, CustomThemesState } from './CustomTheme'
import {
  applyCustomThemeFromState,
  applyCustomThemeOverride,
  loadCustomThemesState,
  removeCustomThemeOverride,
  saveCustomThemesState,
} from './CustomThemeManager'

const STYLE_ID = 'sn-custom-theme'

const theme: CustomTheme = {
  id: 'custom-theme:test',
  name: 'Test',
  colors: { accent: '#ff0000', background: '#ffffff', foreground: '#000000', contrast: '#eeeeee' },
}

beforeEach(() => {
  localStorage.clear()
  document.getElementById(STYLE_ID)?.remove()
})

describe('Custom theme storage', () => {
  it('returns empty state when nothing is stored', () => {
    expect(loadCustomThemesState()).toEqual({ themes: [], selectedId: null })
  })

  it('round-trips state through localStorage', () => {
    const state: CustomThemesState = { themes: [theme], selectedId: theme.id }
    saveCustomThemesState(state)
    const loaded = loadCustomThemesState()
    expect(loaded.themes).toHaveLength(1)
    expect(loaded.themes[0].id).toBe(theme.id)
    expect(loaded.selectedId).toBe(theme.id)
  })

  it('drops a selectedId that no longer points to a theme', () => {
    saveCustomThemesState({ themes: [], selectedId: 'custom-theme:gone' })
    expect(loadCustomThemesState().selectedId).toBeNull()
  })

  it('recovers gracefully from corrupt storage', () => {
    localStorage.setItem('sn-custom-themes', '{ not valid json')
    expect(loadCustomThemesState()).toEqual({ themes: [], selectedId: null })
  })
})

describe('Custom theme runtime injection', () => {
  it('injects a :root override style element', () => {
    applyCustomThemeOverride(theme)
    const element = document.getElementById(STYLE_ID)
    expect(element).not.toBeNull()
    expect(element?.tagName).toBe('STYLE')
    expect(element?.textContent).toContain('--sn-stylekit-info-color: #ff0000;')
  })

  it('removes the override cleanly', () => {
    applyCustomThemeOverride(theme)
    removeCustomThemeOverride()
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('applies from state when a theme is selected', () => {
    applyCustomThemeFromState({ themes: [theme], selectedId: theme.id })
    expect(document.getElementById(STYLE_ID)?.textContent).toContain('#ff0000')
  })

  it('removes the override when nothing is selected', () => {
    applyCustomThemeOverride(theme)
    applyCustomThemeFromState({ themes: [theme], selectedId: null })
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('removes the override when the selected theme is missing', () => {
    applyCustomThemeOverride(theme)
    applyCustomThemeFromState({ themes: [], selectedId: 'custom-theme:gone' })
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('keeps the style element last in <head> so it wins over base theme links', () => {
    applyCustomThemeOverride(theme)
    const link = document.createElement('link')
    document.head.appendChild(link)
    applyCustomThemeOverride(theme)
    expect(document.head.lastElementChild?.id).toBe(STYLE_ID)
  })
})
