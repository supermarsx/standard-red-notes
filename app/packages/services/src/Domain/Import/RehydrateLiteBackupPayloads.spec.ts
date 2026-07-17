import { FullyFormedPayloadInterface } from '@standardnotes/models'
import { rehydrateLiteBackupPayloads } from './RehydrateLiteBackupPayloads'

describe('rehydrateLiteBackupPayloads', () => {
  const fullNote = {
    uuid: 'note-1',
    content: { text: 'real body', title: 'A' },
  } as unknown as FullyFormedPayloadInterface
  const liteNote = {
    uuid: 'note-1',
    content: { title: 'A', __lazyLite: true },
  } as unknown as FullyFormedPayloadInterface
  const encryptedItem = { uuid: 'enc-1', content: '004:...' } as unknown as FullyFormedPayloadInterface

  it('is a pass-through when no payload is lite (flag off)', async () => {
    const sync = { getFullContentPayload: jest.fn() }
    const input = [fullNote, encryptedItem]

    const result = await rehydrateLiteBackupPayloads(input, sync)

    expect(result.payloads).toBe(input)
    expect(result.excludedUuids).toEqual([])
    expect(sync.getFullContentPayload).not.toHaveBeenCalled()
  })

  it('replaces a lite payload with its re-hydrated full body', async () => {
    const rehydrated = { uuid: 'note-1', content: { text: 'real body', title: 'A' } }
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(rehydrated) }

    const result = await rehydrateLiteBackupPayloads([liteNote, encryptedItem], sync)

    expect(sync.getFullContentPayload).toHaveBeenCalledWith('note-1')
    expect(result.payloads).toEqual([rehydrated, encryptedItem])
    // the body-less lite payload must NOT appear in the backup set
    expect(result.payloads).not.toContain(liteNote)
    // a successful re-hydration excludes nothing
    expect(result.excludedUuids).toEqual([])
  })

  it('EXCLUDES a lite payload rather than write it body-less when re-hydration fails', async () => {
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(undefined) }
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rehydrateLiteBackupPayloads([liteNote, encryptedItem], sync)

    expect(result.payloads).toEqual([encryptedItem])
    expect(result.payloads).not.toContain(liteNote)
    // the excluded note's uuid is REPORTED to the caller, not just logged
    expect(result.excludedUuids).toEqual(['note-1'])
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  it('EXCLUDES when re-hydration still returns a lite payload (never writes body-less)', async () => {
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(liteNote) }
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rehydrateLiteBackupPayloads([liteNote], sync)

    expect(result.payloads).toEqual([])
    expect(result.excludedUuids).toEqual(['note-1'])
    consoleErrorSpy.mockRestore()
  })

  it('reports the count/list of ALL excluded notes across a mixed batch', async () => {
    const liteA = { uuid: 'a', content: { title: 'A', __lazyLite: true } } as unknown as FullyFormedPayloadInterface
    const liteB = { uuid: 'b', content: { title: 'B', __lazyLite: true } } as unknown as FullyFormedPayloadInterface
    const rehydratedA = { uuid: 'a', content: { text: 'body A', title: 'A' } }
    const sync = {
      getFullContentPayload: jest
        .fn()
        .mockImplementation((uuid: string) => Promise.resolve(uuid === 'a' ? rehydratedA : undefined)),
    }
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rehydrateLiteBackupPayloads([liteA, liteB, encryptedItem], sync)

    // A re-hydrated, B could not; only B is excluded and it is reported by uuid.
    expect(result.payloads).toEqual([rehydratedA, encryptedItem])
    expect(result.excludedUuids).toEqual(['b'])
    consoleErrorSpy.mockRestore()
  })
})
