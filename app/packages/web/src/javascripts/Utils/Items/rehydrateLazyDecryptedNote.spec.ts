import { ContentType } from '@standardnotes/domain-core'
import {
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
  createLitePayloadFromDecrypted,
} from '@standardnotes/snjs'
import {
  getFullNoteText,
  isLiteNote,
  isRehydrateEmitStillSafe,
  rehydrateNoteForEditing,
} from './rehydrateLazyDecryptedNote'

let uuidCounter = 0
const nextUuid = () => `rehydrate-${uuidCounter++}`

const createFullNote = (text = 'FULL-BODY', uuid = nextUuid()): SNNote => {
  const payload = new DecryptedPayload<NoteContent>(
    {
      uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'T', text }),
      ...PayloadTimestampDefaults(),
    },
    PayloadSource.Constructor,
  )
  return new SNNote(payload)
}

const createLiteNote = (text = 'FULL-BODY', uuid = nextUuid()): SNNote => {
  const full = createFullNote(text, uuid).payload
  return new SNNote(createLitePayloadFromDecrypted(full))
}

/** An `items` slice that reports the given note as the LIVE item for its uuid (still lite + clean). */
const stableItems = (note: SNNote) => ({
  findItem: jest.fn().mockReturnValue({ payload: note.payload, dirty: note.dirty }),
})

describe('rehydrateLazyDecryptedNote', () => {
  describe('isLiteNote', () => {
    it('is false for a full note (the only case when the flag is off)', () => {
      expect(isLiteNote(createFullNote())).toBe(false)
    })

    it('is true for a content-stripped lite note', () => {
      expect(isLiteNote(createLiteNote())).toBe(true)
    })
  })

  describe('getFullNoteText', () => {
    it('returns the in-memory text WITHOUT touching sync for a full note (flag-off path)', async () => {
      const note = createFullNote('IN-MEMORY')
      const sync = { getFullContentPayload: jest.fn() }

      const text = await getFullNoteText(sync, note)

      expect(text).toEqual('IN-MEMORY')
      expect(sync.getFullContentPayload).not.toHaveBeenCalled()
    })

    it('re-hydrates the body from IndexedDB for a lite note', async () => {
      const lite = createLiteNote()
      // The lite note has no body in memory.
      expect(lite.text).toEqual('')

      const fullPayload = createFullNote('REHYDRATED-BODY').payload
      const sync = { getFullContentPayload: jest.fn().mockResolvedValue(fullPayload) }

      const text = await getFullNoteText(sync, lite)

      expect(sync.getFullContentPayload).toHaveBeenCalledWith(lite.uuid)
      expect(text).toEqual('REHYDRATED-BODY')
    })

    it('falls back to the in-memory text when the on-disk payload is missing', async () => {
      const lite = createLiteNote()
      const sync = { getFullContentPayload: jest.fn().mockResolvedValue(undefined) }

      const text = await getFullNoteText(sync, lite)

      expect(text).toEqual(lite.text)
    })
  })

  describe('rehydrateNoteForEditing', () => {
    it('is a no-op for a full note (flag-off path)', async () => {
      const note = createFullNote()
      const app = {
        sync: { getFullContentPayload: jest.fn() },
        items: stableItems(note),
        mutator: { emitItemFromPayload: jest.fn() },
      }

      const result = await rehydrateNoteForEditing(app, note)

      expect(result).toBe(note)
      expect(app.sync.getFullContentPayload).not.toHaveBeenCalled()
      expect(app.mutator.emitItemFromPayload).not.toHaveBeenCalled()
    })

    it('emits the re-hydrated FULL payload back into state for a lite note', async () => {
      const lite = createLiteNote()
      const fullPayload = createFullNote('EDITABLE-BODY').payload
      const app = {
        sync: { getFullContentPayload: jest.fn().mockResolvedValue(fullPayload) },
        items: stableItems(lite),
        mutator: { emitItemFromPayload: jest.fn().mockResolvedValue(undefined) },
      }

      await rehydrateNoteForEditing(app, lite)

      expect(app.sync.getFullContentPayload).toHaveBeenCalledWith(lite.uuid)
      expect(app.mutator.emitItemFromPayload).toHaveBeenCalledTimes(1)
      const [emittedPayload] = app.mutator.emitItemFromPayload.mock.calls[0]
      expect(emittedPayload).toBe(fullPayload)
    })

    it('does not emit when re-hydration fails (caller keeps a usable lite note)', async () => {
      const lite = createLiteNote()
      const app = {
        sync: { getFullContentPayload: jest.fn().mockResolvedValue(undefined) },
        items: stableItems(lite),
        mutator: { emitItemFromPayload: jest.fn() },
      }

      const result = await rehydrateNoteForEditing(app, lite)

      expect(result).toBe(lite)
      expect(app.mutator.emitItemFromPayload).not.toHaveBeenCalled()
    })

    /**
     * FIX 1 (rehydrate-clobber race / silent edit loss): if the live item is no longer lite/clean
     * by the time the async disk read returns (the user typed, or a sync wrote the uuid), emitting
     * the STALE on-disk body would silently overwrite the fresh edit. The guard must ABORT the emit.
     */
    it('does NOT emit (clobber) when the live item became DIRTY mid-rehydrate', async () => {
      const lite = createLiteNote('STALE-DISK-BODY')
      const staleDiskPayload = createFullNote('STALE-DISK-BODY', lite.uuid).payload
      // The live item the user just typed into: a FULL, dirty payload (no longer lite).
      const dirtyEditedPayload = createFullNote('FRESH-USER-EDIT', lite.uuid).payload

      const app = {
        // Disk read returns the stale (pre-edit) body.
        sync: { getFullContentPayload: jest.fn().mockResolvedValue(staleDiskPayload) },
        // Re-reading the live item AFTER the await reflects the fresh dirty edit.
        items: { findItem: jest.fn().mockReturnValue({ payload: dirtyEditedPayload, dirty: true }) },
        mutator: { emitItemFromPayload: jest.fn().mockResolvedValue(undefined) },
      }

      const result = await rehydrateNoteForEditing(app, lite)

      // The rehydrate emit must be aborted so the fresh edit is preserved.
      expect(app.mutator.emitItemFromPayload).not.toHaveBeenCalled()
      expect(result).toBe(lite)
    })

    it('does NOT emit when the live item is no longer lite (a sync wrote a full payload mid-rehydrate)', async () => {
      const lite = createLiteNote('STALE-DISK-BODY')
      const staleDiskPayload = createFullNote('STALE-DISK-BODY', lite.uuid).payload
      const syncedFullPayload = createFullNote('SYNCED-FROM-SERVER', lite.uuid).payload

      const app = {
        sync: { getFullContentPayload: jest.fn().mockResolvedValue(staleDiskPayload) },
        items: { findItem: jest.fn().mockReturnValue({ payload: syncedFullPayload, dirty: false }) },
        mutator: { emitItemFromPayload: jest.fn().mockResolvedValue(undefined) },
      }

      await rehydrateNoteForEditing(app, lite)

      expect(app.mutator.emitItemFromPayload).not.toHaveBeenCalled()
    })
  })

  describe('isRehydrateEmitStillSafe (FIX 1 guard predicate)', () => {
    it('is true when the live item is still lite AND still clean', () => {
      const lite = createLiteNote()
      const items = { findItem: jest.fn().mockReturnValue({ payload: lite.payload, dirty: false }) }
      expect(isRehydrateEmitStillSafe(items, lite.uuid, undefined)).toBe(true)
    })

    it('is false when the live item is now dirty', () => {
      const lite = createLiteNote()
      const items = { findItem: jest.fn().mockReturnValue({ payload: lite.payload, dirty: true }) }
      expect(isRehydrateEmitStillSafe(items, lite.uuid, undefined)).toBe(false)
    })

    it('is false when the live item is no longer lite', () => {
      const full = createFullNote()
      const items = { findItem: jest.fn().mockReturnValue({ payload: full.payload, dirty: false }) }
      expect(isRehydrateEmitStillSafe(items, full.uuid, undefined)).toBe(false)
    })

    it('is false when the live item is gone', () => {
      const items = { findItem: jest.fn().mockReturnValue(undefined) }
      expect(isRehydrateEmitStillSafe(items, 'missing', undefined)).toBe(false)
    })

    it('is false when the dirtyIndex advanced past the start snapshot', () => {
      const lite = createLiteNote()
      const items = {
        findItem: jest.fn().mockReturnValue({ payload: { ...lite.payload, dirtyIndex: 10 }, dirty: false }),
      }
      expect(isRehydrateEmitStillSafe(items, lite.uuid, 5)).toBe(false)
    })
  })
})
