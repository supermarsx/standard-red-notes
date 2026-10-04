import { SNNote } from '@standardnotes/snjs'
import {
  NOTE_COVERS_ENABLED_DEFAULT,
  NOTE_COVERS_ENABLED_PREF_KEY,
  countNotesWithHiddenCover,
  countNotesWithStoredCover,
  describeHiddenCoverCount,
  readNoteCoversEnabled,
  writeNoteCoversEnabled,
} from './noteCoversPreference'

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

const noteWithCover = () =>
  ({ getAppDomainValue: () => ({ imageDataUrl: COVER_DATA_URL, height: 200 }) }) as unknown as SNNote

const noteWithoutCover = () => ({ getAppDomainValue: () => undefined }) as unknown as SNNote

/** A cover whose stored image is junk: no usable cover, so nothing is hidden. */
const noteWithBrokenCover = () =>
  ({ getAppDomainValue: () => ({ imageDataUrl: 'not-a-data-url', height: 200 }) }) as unknown as SNNote

describe('the pinned preference key', () => {
  it('is the literal string the synced preference is stored under', () => {
    // Pinned, not read off the `PrefKey` enum object: web consumes that enum's
    // RUNTIME value from a generated bundle where a newly added member is absent
    // until it is rebuilt. Reading the member yields `undefined`, which silently
    // reads as "off" forever and cannot be turned on.
    expect(NOTE_COVERS_ENABLED_PREF_KEY as unknown as string).toBe('noteCoversEnabled')
  })

  it('defaults to OFF, so covers are opt-in', () => {
    expect(NOTE_COVERS_ENABLED_DEFAULT).toBe(false)
  })
})

describe('readNoteCoversEnabled', () => {
  const readerReturning = (value: unknown) => ({ getPreference: jest.fn(() => value) })

  it('asks for the pinned key with the shipped default', () => {
    const reader = readerReturning(false)

    readNoteCoversEnabled(reader)

    expect(reader.getPreference).toHaveBeenCalledWith(NOTE_COVERS_ENABLED_PREF_KEY, false)
  })

  it('is true only for a literal true', () => {
    expect(readNoteCoversEnabled(readerReturning(true))).toBe(true)
  })

  it('reads anything else as off — this is a synced value another client may have written', () => {
    for (const value of [false, undefined, null, 0, 1, '', 'true', {}]) {
      expect(readNoteCoversEnabled(readerReturning(value))).toBe(false)
    }
  })
})

describe('writeNoteCoversEnabled', () => {
  it('writes the pinned key', async () => {
    const writer = { setPreference: jest.fn().mockResolvedValue(undefined) }

    await writeNoteCoversEnabled(writer, true)

    expect(writer.setPreference).toHaveBeenCalledWith(NOTE_COVERS_ENABLED_PREF_KEY, true)
  })
})

describe('countNotesWithStoredCover', () => {
  it('counts only notes with a usable cover', () => {
    expect(
      countNotesWithStoredCover([noteWithCover(), noteWithoutCover(), noteWithCover(), noteWithBrokenCover()]),
    ).toBe(2)
  })

  it('is 0 for a loaded-but-empty list, which is an honest zero', () => {
    expect(countNotesWithStoredCover([])).toBe(0)
  })

  it('is UNDEFINED when the notes are not available — never 0', () => {
    // "We cannot tell" and "there are none" are different facts. Reporting the
    // first as 0 is the claim-more-than-your-source-establishes bug, and it is
    // what would make the setting's copy state something it does not know.
    expect(countNotesWithStoredCover(undefined)).toBeUndefined()
    expect(countNotesWithStoredCover(null)).toBeUndefined()
  })
})

describe('countNotesWithHiddenCover', () => {
  it('counts the stored covers while the gate is OFF, because those are the hidden ones', () => {
    expect(countNotesWithHiddenCover([noteWithCover(), noteWithoutCover(), noteWithCover()], false)).toBe(2)
  })

  it('is 0 while the gate is ON, because nothing is hidden then', () => {
    expect(countNotesWithHiddenCover([noteWithCover(), noteWithCover()], true)).toBe(0)
  })

  it('is UNDEFINED when the notes are not available, whichever way the gate is set', () => {
    expect(countNotesWithHiddenCover(undefined, false)).toBeUndefined()
    expect(countNotesWithHiddenCover(undefined, true)).toBeUndefined()
  })
})

describe('describeHiddenCoverCount', () => {
  it('says nothing when the count is unknown', () => {
    expect(describeHiddenCoverCount(undefined)).toBeUndefined()
  })

  it('says nothing when the count is zero, rather than warning about nothing', () => {
    expect(describeHiddenCoverCount(0)).toBeUndefined()
  })

  it('uses the singular at one', () => {
    expect(describeHiddenCoverCount(1)).toBe('1 note has a hidden cover.')
  })

  it('uses the plural above one', () => {
    expect(describeHiddenCoverCount(7)).toBe('7 notes have a hidden cover.')
  })
})
