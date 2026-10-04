/**
 * Standard Red Notes (t111 §C): the note-covers WRITE GATE.
 *
 * Covers are opt-in and default off. While the gate is off nothing may CREATE or
 * GROW a cover — a feature the user has not enabled must not be able to add
 * bytes to their synced, end-to-end-encrypted note payloads.
 *
 * The sharp part, and the reason this file exists rather than one blanket guard
 * inside `writeNoteHeroHeader`: **removal is NEVER gated**. Turning the setting
 * off hides covers that already exist, and the hidden-cover notice offers to
 * delete one. Requiring the user to switch the feature ON in order to get rid of
 * one of its leftovers would be absurd, so the remover has to work with the gate
 * shut. A single guard in the shared writer would have broken exactly that, and
 * it would have type-checked.
 */
import { SNNote } from '@standardnotes/snjs'
import { NotesController } from './NotesController'
import { NOTE_COVERS_ENABLED_PREF_KEY } from '../../HeroHeader/noteCoversPreference'
import { HeroHeader } from '../../HeroHeader/heroHeader'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  dismissToast: jest.fn(),
  updateToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Info: 'info', Progress: 'progress', Regular: 'regular' },
}))

jest.mock('@/Achievements', () => ({
  achievements: { increment: jest.fn(), setAtLeast: jest.fn() },
  METRICS: new Proxy({}, { get: (_target, key) => String(key) }),
}))

jest.mock('@/Services/Achievements/restoreCounter', () => ({
  recordItemRestore: jest.fn(() => 1),
}))

jest.mock('../../Utils/Items/rehydrateLazyDecryptedNote', () => ({
  rehydrateNoteForEditing: jest.fn().mockResolvedValue(undefined),
}))

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'
const OTHER_COVER_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA'

const aStoredCover: HeroHeader = { imageDataUrl: COVER_DATA_URL, height: 320, focalY: 0.4 }

type Harness = ReturnType<typeof createHarness>

const createHarness = (options: { coversEnabled: boolean; storedCover?: HeroHeader; locked?: boolean }) => {
  let coversEnabled = options.coversEnabled

  const note = {
    uuid: 'note-1',
    locked: options.locked ?? false,
    /** Non-lite enough for `isLitePayload` to say "writable". */
    payload: {},
    getAppDomainValue: jest.fn(() => options.storedCover),
  } as unknown as SNNote

  const changeItem = jest.fn().mockResolvedValue(note)

  const getPreference = jest.fn((key: unknown, defaultValue: unknown) =>
    key === NOTE_COVERS_ENABLED_PREF_KEY ? coversEnabled : defaultValue,
  )

  const application = {
    getPreference,
    setPreference: jest.fn(async (key: unknown, value: unknown) => {
      if (key === NOTE_COVERS_ENABLED_PREF_KEY) {
        coversEnabled = value === true
      }
    }),
    items: { findItem: () => note },
    mutator: { changeItem },
    sync: { sync: jest.fn().mockResolvedValue(undefined) },
  }

  const controller = Object.create(NotesController.prototype) as NotesController
  Object.assign(controller as object, { application })

  return {
    controller,
    note,
    changeItem,
    getPreference,
    application,
    setCoversEnabled: (value: boolean) => {
      coversEnabled = value
    },
  }
}

/** The hero-header value the controller actually wrote, via a real-ish mutator. */
const writtenHeroHeader = (harness: Harness): unknown => {
  expect(harness.changeItem).toHaveBeenCalled()
  const mutate = harness.changeItem.mock.calls[0][1] as (mutator: {
    setAppDataItem: (key: string, value: unknown) => void
  }) => void
  const written: Record<string, unknown> = {}
  mutate({
    setAppDataItem: (key, value) => {
      written[String(key)] = value
    },
  })
  return written['heroHeader']
}

describe('the additive cover writers are gated', () => {
  it('setNoteHeroImage writes nothing while covers are off', async () => {
    const harness = createHarness({ coversEnabled: false })

    await harness.controller.setNoteHeroImage(harness.note, COVER_DATA_URL)

    expect(harness.changeItem).not.toHaveBeenCalled()
  })

  it('setNoteHeroHeight writes nothing while covers are off', async () => {
    const harness = createHarness({ coversEnabled: false, storedCover: aStoredCover })

    await harness.controller.setNoteHeroHeight(harness.note, 400)

    expect(harness.changeItem).not.toHaveBeenCalled()
  })

  it('setNoteHeroFocalY writes nothing while covers are off', async () => {
    const harness = createHarness({ coversEnabled: false, storedCover: aStoredCover })

    await harness.controller.setNoteHeroFocalY(harness.note, 0.9)

    expect(harness.changeItem).not.toHaveBeenCalled()
  })

  it('reads the gate from the pinned literal key, not from the PrefKey enum object', async () => {
    // Web consumes `PrefKey`'s runtime value from a generated bundle where a new
    // member is absent until it is rebuilt. Reading the member would resolve to
    // `undefined`, the gate would read `undefined !== true` and covers would be
    // permanently off with no way to turn them on.
    const harness = createHarness({ coversEnabled: false })

    await harness.controller.setNoteHeroImage(harness.note, COVER_DATA_URL)

    expect(harness.getPreference).toHaveBeenCalledWith(NOTE_COVERS_ENABLED_PREF_KEY, false)
    expect(NOTE_COVERS_ENABLED_PREF_KEY as unknown as string).toBe('noteCoversEnabled')
  })
})

describe('the additive cover writers work once covers are on', () => {
  it('setNoteHeroImage stores the cover', async () => {
    const harness = createHarness({ coversEnabled: true })

    await harness.controller.setNoteHeroImage(harness.note, COVER_DATA_URL)

    expect(writtenHeroHeader(harness)).toMatchObject({ imageDataUrl: COVER_DATA_URL })
  })

  it('setNoteHeroHeight stores the clamped height', async () => {
    const harness = createHarness({ coversEnabled: true, storedCover: aStoredCover })

    await harness.controller.setNoteHeroHeight(harness.note, 400)

    expect(writtenHeroHeader(harness)).toMatchObject({ imageDataUrl: COVER_DATA_URL, height: 400 })
  })

  it('setNoteHeroFocalY stores the clamped focal point', async () => {
    const harness = createHarness({ coversEnabled: true, storedCover: aStoredCover })

    await harness.controller.setNoteHeroFocalY(harness.note, 0.9)

    expect(writtenHeroHeader(harness)).toMatchObject({ focalY: 0.9 })
  })
})

describe('removeNoteHeroHeader is NEVER gated', () => {
  it('deletes a hidden cover while covers are OFF', async () => {
    const harness = createHarness({ coversEnabled: false, storedCover: aStoredCover })

    await harness.controller.removeNoteHeroHeader(harness.note)

    // `undefined` is how `setAppDataItem` clears the key.
    expect(harness.changeItem).toHaveBeenCalledTimes(1)
    expect(writtenHeroHeader(harness)).toBeUndefined()
  })

  it('still deletes a cover while covers are ON', async () => {
    const harness = createHarness({ coversEnabled: true, storedCover: aStoredCover })

    await harness.controller.removeNoteHeroHeader(harness.note)

    expect(writtenHeroHeader(harness)).toBeUndefined()
  })

  it('still refuses to write a LOCKED note, gate or no gate', async () => {
    // The locked guard inside `writeNoteHeroHeader` is untouched by the feature
    // gate — which is exactly why the hidden-cover notice hides [Remove cover]
    // on a locked note instead of offering a button that cannot work.
    const harness = createHarness({ coversEnabled: false, storedCover: aStoredCover, locked: true })

    await harness.controller.removeNoteHeroHeader(harness.note)

    expect(harness.changeItem).not.toHaveBeenCalled()
  })
})

describe('toggling the preference mutates no note', () => {
  it('writes the preference and nothing else across off -> on -> off', async () => {
    const harness = createHarness({ coversEnabled: false, storedCover: aStoredCover })

    await harness.application.setPreference(NOTE_COVERS_ENABLED_PREF_KEY, true)
    await harness.application.setPreference(NOTE_COVERS_ENABLED_PREF_KEY, false)

    // No migration, no cleanup pass, no lazy rewrite: the stored value is never
    // read-modified-written by a toggle, so it round-trips byte-identically and
    // re-enabling restores the cover exactly.
    expect(harness.changeItem).not.toHaveBeenCalled()
    expect(harness.note.getAppDomainValue('heroHeader' as unknown as never)).toBe(aStoredCover)
  })

  it('a cover stored while covers were on survives the gate closing and reopening', async () => {
    const harness = createHarness({ coversEnabled: true })

    await harness.controller.setNoteHeroImage(harness.note, OTHER_COVER_DATA_URL)
    const writes = harness.changeItem.mock.calls.length

    harness.setCoversEnabled(false)
    harness.setCoversEnabled(true)

    expect(harness.changeItem.mock.calls.length).toBe(writes)
  })
})
