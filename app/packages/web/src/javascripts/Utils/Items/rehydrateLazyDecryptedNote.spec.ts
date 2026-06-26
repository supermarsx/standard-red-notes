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
import { getFullNoteText, isLiteNote, rehydrateNoteForEditing } from './rehydrateLazyDecryptedNote'

let uuidCounter = 0
const nextUuid = () => `rehydrate-${uuidCounter++}`

const createFullNote = (text = 'FULL-BODY'): SNNote => {
  const payload = new DecryptedPayload<NoteContent>(
    {
      uuid: nextUuid(),
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'T', text }),
      ...PayloadTimestampDefaults(),
    },
    PayloadSource.Constructor,
  )
  return new SNNote(payload)
}

const createLiteNote = (text = 'FULL-BODY'): SNNote => {
  const full = createFullNote(text).payload
  return new SNNote(createLitePayloadFromDecrypted(full))
}

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
        mutator: { emitItemFromPayload: jest.fn() },
      }

      const result = await rehydrateNoteForEditing(app, lite)

      expect(result).toBe(lite)
      expect(app.mutator.emitItemFromPayload).not.toHaveBeenCalled()
    })
  })
})
