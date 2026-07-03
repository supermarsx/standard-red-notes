import { FullyFormedPayloadInterface } from '@standardnotes/models'
import { rehydrateLiteBackupPayloads } from './RehydrateLiteBackupPayloads'

describe('rehydrateLiteBackupPayloads', () => {
  const fullNote = { uuid: 'note-1', content: { text: 'real body', title: 'A' } } as unknown as FullyFormedPayloadInterface
  const liteNote = {
    uuid: 'note-1',
    content: { title: 'A', __lazyLite: true },
  } as unknown as FullyFormedPayloadInterface
  const encryptedItem = { uuid: 'enc-1', content: '004:...' } as unknown as FullyFormedPayloadInterface

  it('is a pass-through when no payload is lite (flag off)', async () => {
    const sync = { getFullContentPayload: jest.fn() }
    const input = [fullNote, encryptedItem]

    const result = await rehydrateLiteBackupPayloads(input, sync)

    expect(result).toBe(input)
    expect(sync.getFullContentPayload).not.toHaveBeenCalled()
  })

  it('replaces a lite payload with its re-hydrated full body', async () => {
    const rehydrated = { uuid: 'note-1', content: { text: 'real body', title: 'A' } }
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(rehydrated) }

    const result = await rehydrateLiteBackupPayloads([liteNote, encryptedItem], sync)

    expect(sync.getFullContentPayload).toHaveBeenCalledWith('note-1')
    expect(result).toEqual([rehydrated, encryptedItem])
    // the body-less lite payload must NOT appear in the backup set
    expect(result).not.toContain(liteNote)
  })

  it('EXCLUDES a lite payload rather than write it body-less when re-hydration fails', async () => {
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(undefined) }
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rehydrateLiteBackupPayloads([liteNote, encryptedItem], sync)

    expect(result).toEqual([encryptedItem])
    expect(result).not.toContain(liteNote)
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  it('EXCLUDES when re-hydration still returns a lite payload (never writes body-less)', async () => {
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(liteNote) }
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await rehydrateLiteBackupPayloads([liteNote], sync)

    expect(result).toEqual([])
    consoleErrorSpy.mockRestore()
  })
})
