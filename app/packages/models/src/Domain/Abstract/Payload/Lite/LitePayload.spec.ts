import { ContentType } from '@standardnotes/domain-core'
import { DecryptedPayload } from '../Implementations/DecryptedPayload'
import { PayloadSource } from '../Types/PayloadSource'
import { PayloadTimestampDefaults } from '../Overrides/TimestampDefaults'
import { FillItemContent } from '../../Content/ItemContent'
import { NoteContent } from '../../../Syncable/Note/NoteContent'
import { SNNote } from '../../../Syncable/Note/Note'
import { NoteMutator } from '../../../Syncable/Note/NoteMutator'
import { MutationType } from '../../Item/Types/MutationType'
import {
  createLitePayloadFromDecrypted,
  isLitePayload,
  isLiteContent,
  stripContentToLiteProjection,
  LiteContentMarkerKey,
} from './LitePayload'
import { assertNotLitePayload, assertNoLitePayloads, LitePayloadSafetyError } from './LiteSafetyGuard'

let uuidCounter = 0
const nextUuid = () => `lite-uuid-${uuidCounter++}`

const createNotePayload = (content: Partial<NoteContent>, overrides: Record<string, unknown> = {}) => {
  return new DecryptedPayload<NoteContent>(
    {
      uuid: nextUuid(),
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({
        title: 'Title',
        text: 'BODY-TEXT-THAT-MUST-NEVER-LEAK',
        preview_plain: 'preview',
        ...content,
      }),
      ...PayloadTimestampDefaults(),
      ...overrides,
    },
    PayloadSource.Constructor,
  )
}

describe('lite payload representation', () => {
  it('strips text but retains metadata projection fields', () => {
    const full = createNotePayload({
      title: 'My Note',
      preview_plain: 'preview plain',
      preview_html: '<p>preview</p>',
      hidePreview: true,
      pinned: true,
      archived: true,
      starred: true,
      trashed: false,
      protected: true,
    })

    const lite = createLitePayloadFromDecrypted(full)

    // body stripped
    expect((lite.content as NoteContent).text).toBeUndefined()

    // metadata retained
    expect((lite.content as NoteContent).title).toEqual('My Note')
    expect((lite.content as NoteContent).preview_plain).toEqual('preview plain')
    expect((lite.content as NoteContent).preview_html).toEqual('<p>preview</p>')
    expect((lite.content as NoteContent).hidePreview).toEqual(true)
    expect(lite.content.pinned).toEqual(true)
    expect(lite.content.archived).toEqual(true)
    expect(lite.content.starred).toEqual(true)
    expect(lite.content.protected).toEqual(true)
    expect(lite.content.references).toBeDefined()

    // identity preserved
    expect(lite.uuid).toEqual(full.uuid)
    expect(lite.content_type).toEqual(full.content_type)
  })

  it('marks the lite payload detectable via isLitePayload / isLiteContent', () => {
    const full = createNotePayload({})
    const lite = createLitePayloadFromDecrypted(full)

    expect(isLitePayload(full)).toBe(false)
    expect(isLitePayload(lite)).toBe(true)
    expect(isLiteContent(lite.content)).toBe(true)
    expect((lite.content as unknown as Record<string, unknown>)[LiteContentMarkerKey]).toBe(true)
  })

  it('stripContentToLiteProjection removes text and stamps marker', () => {
    const content = FillItemContent<NoteContent>({ title: 'T', text: 'secret' })
    const stripped = stripContentToLiteProjection(content)
    expect((stripped as NoteContent).text).toBeUndefined()
    expect((stripped as unknown as Record<string, unknown>)[LiteContentMarkerKey]).toBe(true)
  })

  it('a lite payload is NEVER dirty by construction', () => {
    const full = createNotePayload({}, { dirty: true, dirtyIndex: 5 })
    expect(full.dirty).toBe(true)

    const lite = createLitePayloadFromDecrypted(full)
    expect(lite.dirty).toBe(false)
    expect(lite.dirtyIndex).toBeUndefined()
  })

  it('isLitePayload returns false for undefined/null', () => {
    expect(isLitePayload(undefined)).toBe(false)
    expect(isLitePayload(null)).toBe(false)
  })
})

describe('SAFETY INVARIANT: lite payloads can never be mutated/marked dirty', () => {
  it('ItemMutator.getResult throws when mutating a lite payload (dirtying mutation)', () => {
    const full = createNotePayload({ title: 'Original' })
    const lite = createLitePayloadFromDecrypted(full)
    const liteNote = new SNNote(lite)

    const mutator = new NoteMutator(liteNote, MutationType.UpdateUserTimestamps)
    mutator.title = 'Changed'

    expect(() => mutator.getResult()).toThrow(LitePayloadSafetyError)
  })

  it('a NON-lite (full) payload mutates normally and becomes dirty', () => {
    const full = createNotePayload({ title: 'Original' })
    const fullNote = new SNNote(full)

    const mutator = new NoteMutator(fullNote, MutationType.UpdateUserTimestamps)
    mutator.title = 'Changed'
    const result = mutator.getResult()

    expect(result.dirty).toBe(true)
    expect(result.content.title).toEqual('Changed')
  })

  it('NonDirtying mutation does not throw on a lite payload (read-only system mutation)', () => {
    const full = createNotePayload({ title: 'Original' })
    const lite = createLitePayloadFromDecrypted(full)
    const liteNote = new SNNote(lite)

    const mutator = new NoteMutator(liteNote, MutationType.NonDirtying)
    expect(() => mutator.getResult()).not.toThrow()
    expect(mutator.getResult().dirty).not.toBe(true)
  })
})

describe('SAFETY INVARIANT: the sync/dirty seam guard refuses lite payloads', () => {
  it('assertNotLitePayload throws for a lite payload', () => {
    const lite = createLitePayloadFromDecrypted(createNotePayload({}))
    expect(() => assertNotLitePayload(lite, 'test-seam')).toThrow(LitePayloadSafetyError)
  })

  it('assertNotLitePayload is a no-op for a full payload', () => {
    const full = createNotePayload({})
    expect(() => assertNotLitePayload(full, 'test-seam')).not.toThrow()
  })

  it('assertNoLitePayloads throws if ANY payload in a batch is lite', () => {
    const full1 = createNotePayload({})
    const full2 = createNotePayload({})
    const lite = createLitePayloadFromDecrypted(createNotePayload({}))

    expect(() => assertNoLitePayloads([full1, full2], 'batch-seam')).not.toThrow()
    expect(() => assertNoLitePayloads([full1, lite, full2], 'batch-seam')).toThrow(LitePayloadSafetyError)
  })

  it('the thrown error names the seam and uuid for diagnosis', () => {
    const lite = createLitePayloadFromDecrypted(createNotePayload({}))
    try {
      assertNotLitePayload(lite, 'my-special-seam')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('my-special-seam')
      expect((e as Error).message).toContain(lite.uuid)
    }
  })
})
