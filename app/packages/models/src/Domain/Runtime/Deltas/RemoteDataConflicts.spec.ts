import { ContentType } from '@standardnotes/domain-core'
import { ConflictType } from '@standardnotes/responses'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { DecryptedPayload, FullyFormedPayloadInterface, PayloadTimestampDefaults } from '../../Abstract/Payload'
import { NoteContent } from '../../Syncable/Note'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { HistoryMap } from '../History'
import { DeltaRemoteDataConflicts } from './RemoteDataConflicts'
import { ConflictConflictingDataParams } from '@standardnotes/responses'

UuidGenerator.SetGenerator(() => String(Math.random()))

describe('remote data conflicts delta', () => {
  const baseCollection = () => {
    const collection = new PayloadCollection()
    collection.set(
      new DecryptedPayload<NoteContent>({
        uuid: '123',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'foo' }),
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 1,
      }),
    )
    return ImmutablePayloadCollection.FromCollection(collection)
  }

  it('does not throw and ignores a conflicting_data conflict missing its server_item', () => {
    // Regression: a server_item dropped by payload filtering must never crash resolution.
    const conflict = {
      type: ConflictType.ConflictingData,
      server_item: undefined,
    } as unknown as ConflictConflictingDataParams<FullyFormedPayloadInterface>

    const delta = new DeltaRemoteDataConflicts(baseCollection(), [conflict], {} as HistoryMap)

    const result = delta.result()

    expect(result.emits).toHaveLength(0)
    expect(result.ignored).toHaveLength(0)
  })
})
