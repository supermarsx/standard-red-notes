import {
  resolveColorSchemeTheme,
  StandardBlueThemeIdentifier,
  StandardRedThemeIdentifier,
} from './ResolveColorSchemeTheme'

describe('resolveColorSchemeTheme', () => {
  it('light mode always resolves to Standard Blue regardless of OS', () => {
    expect(resolveColorSchemeTheme('light', true)).toBe(StandardBlueThemeIdentifier)
    expect(resolveColorSchemeTheme('light', false)).toBe(StandardBlueThemeIdentifier)
    expect(resolveColorSchemeTheme('light', undefined)).toBe(StandardBlueThemeIdentifier)
  })

  it('dark mode always resolves to Standard Red regardless of OS', () => {
    expect(resolveColorSchemeTheme('dark', true)).toBe(StandardRedThemeIdentifier)
    expect(resolveColorSchemeTheme('dark', false)).toBe(StandardRedThemeIdentifier)
    expect(resolveColorSchemeTheme('dark', undefined)).toBe(StandardRedThemeIdentifier)
  })

  it('auto mode follows the OS color scheme', () => {
    expect(resolveColorSchemeTheme('auto', true)).toBe(StandardRedThemeIdentifier)
    expect(resolveColorSchemeTheme('auto', false)).toBe(StandardBlueThemeIdentifier)
  })

  it('auto mode falls back to dark (Standard Red) when the OS preference is indeterminate', () => {
    expect(resolveColorSchemeTheme('auto', undefined)).toBe(StandardRedThemeIdentifier)
  })

  it('Standard Red is the default base look identifier', () => {
    expect(StandardRedThemeIdentifier).toBe('Default')
  })

  it('Standard Blue is the standard-notes-blue native theme identifier', () => {
    expect(StandardBlueThemeIdentifier).toBe('org.standardnotes.theme-standard-notes-blue')
  })
})
