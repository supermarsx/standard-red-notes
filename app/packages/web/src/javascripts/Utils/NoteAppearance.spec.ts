import { SNNote } from '@standardnotes/snjs'
import {
  NoteAppearancePresets,
  NoteCustomBackgroundColorKey,
  NoteCustomTextColorKey,
  getNoteAppearanceColors,
  getNoteCustomBackgroundColor,
  getNoteCustomTextColor,
  noteHasCustomAppearance,
} from './NoteAppearance'

/**
 * Minimal stub mirroring the only SNNote surface these helpers touch:
 * `getAppDomainValue(key)`. Backed by a plain record of app-domain values.
 */
const makeNote = (values: Record<string, string | undefined>): SNNote =>
  ({
    getAppDomainValue: (key: string) => values[key],
  }) as unknown as SNNote

describe('NoteAppearance', () => {
  it('reads the custom background color from the note app-domain bag', () => {
    const note = makeNote({ [NoteCustomBackgroundColorKey as unknown as string]: '#fff8c4' })
    expect(getNoteCustomBackgroundColor(note)).toBe('#fff8c4')
  })

  it('reads the custom text color from the note app-domain bag', () => {
    const note = makeNote({ [NoteCustomTextColorKey as unknown as string]: '#403a00' })
    expect(getNoteCustomTextColor(note)).toBe('#403a00')
  })

  it('returns undefined for each color when no override is stored', () => {
    const note = makeNote({})
    expect(getNoteCustomBackgroundColor(note)).toBeUndefined()
    expect(getNoteCustomTextColor(note)).toBeUndefined()
  })

  describe('getNoteAppearanceColors', () => {
    it('returns both colors when set', () => {
      const note = makeNote({
        [NoteCustomBackgroundColorKey as unknown as string]: '#1f2933',
        [NoteCustomTextColorKey as unknown as string]: '#e6edf3',
      })
      expect(getNoteAppearanceColors(note)).toEqual({
        backgroundColor: '#1f2933',
        textColor: '#e6edf3',
      })
    })

    it('returns undefined values when nothing is set', () => {
      expect(getNoteAppearanceColors(makeNote({}))).toEqual({
        backgroundColor: undefined,
        textColor: undefined,
      })
    })
  })

  describe('noteHasCustomAppearance', () => {
    it('is true when only a background color is set', () => {
      expect(noteHasCustomAppearance(makeNote({ [NoteCustomBackgroundColorKey as unknown as string]: '#fff' }))).toBe(
        true,
      )
    })

    it('is true when only a text color is set', () => {
      expect(noteHasCustomAppearance(makeNote({ [NoteCustomTextColorKey as unknown as string]: '#000' }))).toBe(true)
    })

    it('is false when neither color is set', () => {
      expect(noteHasCustomAppearance(makeNote({}))).toBe(false)
    })
  })

  describe('NoteAppearancePresets', () => {
    it('exposes well-formed presets with hex colors and names', () => {
      expect(NoteAppearancePresets.length).toBeGreaterThan(0)
      for (const preset of NoteAppearancePresets) {
        expect(preset.name).toBeTruthy()
        expect(preset.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i)
        expect(preset.textColor).toMatch(/^#[0-9a-f]{6}$/i)
      }
    })

    it('has unique preset names', () => {
      const names = NoteAppearancePresets.map((preset) => preset.name)
      expect(new Set(names).size).toBe(names.length)
    })
  })
})
