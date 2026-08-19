import {
  ContentType,
  FullyFormedTransferPayload,
  PayloadEmitSource,
  PayloadManagerInterface,
  PayloadSource,
  StorageServiceInterface,
} from '@standardnotes/snjs'
import { reloadForeignDatabasePayloads } from './ReloadForeignDatabasePayloads'

const rawPayload = (uuid: string): FullyFormedTransferPayload => ({
  uuid,
  content_type: ContentType.TYPES.Note,
  content: { references: [] },
  created_at: new Date(0),
  updated_at: new Date(1),
  created_at_timestamp: 0,
  updated_at_timestamp: 1,
})

describe('reloadForeignDatabasePayloads', () => {
  it('coalesces UUIDs and reloads from disk without scheduling or persisting another sync edge', async () => {
    const storage = {
      getRawPayloads: jest.fn().mockResolvedValue([rawPayload('a'), rawPayload('b')]),
    } as unknown as jest.Mocked<Pick<StorageServiceInterface, 'getRawPayloads'>>
    const payloads = {
      emitPayloads: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Pick<PayloadManagerInterface, 'emitPayloads'>>

    await reloadForeignDatabasePayloads(['a', 'b', 'a'], storage, payloads)

    expect(storage.getRawPayloads).toHaveBeenCalledTimes(1)
    expect(storage.getRawPayloads).toHaveBeenCalledWith(['a', 'b'])
    expect(payloads.emitPayloads).toHaveBeenCalledTimes(1)
    const [emitted, source] = payloads.emitPayloads.mock.calls[0]
    expect(source).toBe(PayloadEmitSource.LocalDatabaseLoaded)
    expect(emitted.map((payload) => payload.uuid)).toEqual(['a', 'b'])
    expect(emitted.every((payload) => payload.source === PayloadSource.LocalDatabaseLoaded)).toBe(true)
  })

  it('does nothing for an empty invalidation batch', async () => {
    const storage = { getRawPayloads: jest.fn() }
    const payloads = { emitPayloads: jest.fn() }

    await reloadForeignDatabasePayloads([], storage as never, payloads as never)

    expect(storage.getRawPayloads).not.toHaveBeenCalled()
    expect(payloads.emitPayloads).not.toHaveBeenCalled()
  })
})
