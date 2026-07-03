import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { NoteContent } from '../../Syncable/Note/NoteContent'
import { DecryptedPayload } from '../../Abstract/Payload/Implementations/DecryptedPayload'
import { PayloadSource } from '../../Abstract/Payload/Types/PayloadSource'
import { PayloadTimestampDefaults } from '../../Abstract/Payload/Overrides/TimestampDefaults'
import { createLitePayloadFromDecrypted, isLitePayload } from '../../Abstract/Payload/Lite/LitePayload'
import { ImmutablePayloadCollection } from '../../Runtime/Collection/Payload/ImmutablePayloadCollection'
import { PayloadCollection } from '../../Runtime/Collection/Payload/PayloadCollection'
import { PayloadsByDuplicating } from './PayloadsByDuplicating'
import { UuidGenerator } from '@standardnotes/utils'

UuidGenerator.SetGenerator(() => String(Math.random()))

let uuidCounter = 0
const nextUuid = () => `dup-uuid-${uuidCounter++}`

const createNotePayload = () => {
  return new DecryptedPayload<NoteContent>(
    {
      uuid: nextUuid(),
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'Title', text: 'real body' }),
      ...PayloadTimestampDefaults(),
    },
    PayloadSource.Constructor,
  )
}

describe('PayloadsByDuplicating — LAZY-DECRYPT data-loss guard', () => {
  const emptyCollection = () => ImmutablePayloadCollection.FromCollection(new PayloadCollection())

  it('REFUSES to duplicate a content-stripped (lite) note — emits nothing rather than a body-less copy', () => {
    const lite = createLitePayloadFromDecrypted(createNotePayload())
    expect(isLitePayload(lite)).toBe(true)

    const results = PayloadsByDuplicating({
      payload: lite,
      baseCollection: emptyCollection(),
      isConflict: true,
    })

    // No duplicate is produced: no phantom empty conflicted-copy, nothing carrying the lite marker.
    expect(results).toEqual([])
  })

  it('still duplicates a normal (non-lite) decrypted payload as before', () => {
    const full = createNotePayload()
    expect(isLitePayload(full)).toBe(false)

    const results = PayloadsByDuplicating({
      payload: full,
      baseCollection: emptyCollection(),
      isConflict: true,
    })

    expect(results.length).toBeGreaterThanOrEqual(1)
    const copy = results[0]
    expect(copy.uuid).not.toEqual(full.uuid)
    expect(copy.dirty).toBe(true)
    expect((copy as { duplicate_of?: string }).duplicate_of).toEqual(full.uuid)
    expect((copy.content as { conflict_of?: string }).conflict_of).toEqual(full.uuid)
    expect((copy.content as { text?: string }).text).toEqual('real body')
    expect(isLitePayload(copy)).toBe(false)
  })
})
