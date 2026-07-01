import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent } from '../../../Abstract/Content/ItemContent'
import { DecryptedPayload, FullyFormedPayloadInterface, PayloadTimestampDefaults } from '../../../Abstract/Payload'
import { NoteContent } from '../../../Syncable/Note'
import { ImmutablePayloadCollection } from './ImmutablePayloadCollection'
import { PayloadCollection } from './PayloadCollection'

describe('ImmutablePayloadCollection copy aliasing', () => {
  const createNote = (uuid: string, title: string): FullyFormedPayloadInterface => {
    return new DecryptedPayload<NoteContent>({
      uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({
        title,
        text: '',
      }),
      ...PayloadTimestampDefaults(),
    })
  }

  it('mutating a mutableCopy must not corrupt the immutable source typed-map arrays', () => {
    const source = ImmutablePayloadCollection.WithPayloads([createNote('a', 'A')])
    expect(source.all(ContentType.TYPES.Note).length).toBe(1)

    const copy = source.mutableCopy()
    copy.set(createNote('b', 'B'))

    /** The copy gains the new note... */
    expect(copy.all(ContentType.TYPES.Note).length).toBe(2)
    /** ...but the (frozen) immutable source must be unaffected — proving arrays are not shared. */
    expect(source.all(ContentType.TYPES.Note).length).toBe(1)
  })

  it('discarding from a mutableCopy must not remove items from the immutable source', () => {
    const note = createNote('a', 'A')
    const source = ImmutablePayloadCollection.WithPayloads([note])

    const copy = source.mutableCopy()
    copy.discard(note)

    expect(copy.all(ContentType.TYPES.Note).length).toBe(0)
    expect(source.all(ContentType.TYPES.Note).length).toBe(1)
  })

  it('FromCollection copy must be independent of the originating collection', () => {
    const original = new PayloadCollection()
    original.set(createNote('a', 'A'))

    const immutable = ImmutablePayloadCollection.FromCollection(original)
    expect(immutable.all(ContentType.TYPES.Note).length).toBe(1)

    /** Mutating the original after the snapshot must not leak into the immutable copy. */
    original.set(createNote('b', 'B'))

    expect(immutable.all(ContentType.TYPES.Note).length).toBe(1)
    expect(original.all(ContentType.TYPES.Note).length).toBe(2)
  })
})
