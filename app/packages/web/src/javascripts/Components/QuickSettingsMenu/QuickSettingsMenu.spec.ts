import { ThemeFeatureDescription, UIFeature } from '@standardnotes/snjs'
import { NativeFeatureIdentifier } from '@standardnotes/features'
import { excludeFirstClassStandardRed, isStandardRedSelectionActive, isStandardRedTheme } from './QuickSettingsMenu'

type FakeTheme = UIFeature<ThemeFeatureDescription>

function fakeTheme(featureIdentifier: string, layerable = false): FakeTheme {
  return {
    featureIdentifier,
    layerable,
    uniqueIdentifier: { value: featureIdentifier },
  } as FakeTheme
}

describe('Quick Settings Standard Red choice', () => {
  const standardRed = fakeTheme(NativeFeatureIdentifier.TYPES.StandardRedTheme)
  const standardBlue = fakeTheme(NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme)
  const overlay = fakeTheme('theme-overlay', true)

  it('filters the first-class descriptor because the menu supplies one synthetic Standard Red row', () => {
    expect(isStandardRedTheme(standardRed)).toBe(true)
    expect(excludeFirstClassStandardRed([standardRed, standardBlue, overlay])).toEqual([standardBlue, overlay])
  })

  it('marks the synthetic row active for both the legacy implicit base and first-class Standard Red', () => {
    expect(isStandardRedSelectionActive(false, undefined)).toBe(true)
    expect(isStandardRedSelectionActive(false, standardRed)).toBe(true)
    expect(isStandardRedSelectionActive(false, standardBlue)).toBe(false)
  })

  it('shows no built-in base as selected while a custom theme owns appearance', () => {
    expect(isStandardRedSelectionActive(true, undefined)).toBe(false)
    expect(isStandardRedSelectionActive(true, standardRed)).toBe(false)
  })
})
