import { ContentType } from '@standardnotes/domain-core'
import { CreateDecryptedBackupFile } from './CreateDecryptedBackupFile'

// The decrypted backup is human-consumable / plaintext output, so it must NOT carry an items key
// (a plaintext items key is key-material leak) or user preferences (private settings noise). Plain
// object payloads are enough: isDecryptedPayload only checks that `content` is an object, and
// nothing here is a lite payload so re-hydration is a pass-through.
const decryptedPayload = (uuid: string, contentType: string) => ({
  uuid,
  content_type: contentType,
  content: { title: uuid },
})

describe('CreateDecryptedBackupFile', () => {
  const buildUseCase = (
    nonDeletedItems: unknown[],
    authorized = true,
    sync: { getFullContentPayload: jest.Mock } = { getFullContentPayload: jest.fn() },
  ) => {
    const payloads = { nonDeletedItems } as never
    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(authorized) } as never
    return new CreateDecryptedBackupFile(payloads, protections, sync as never)
  }

  it('EXCLUDES the items key and user preferences, keeping notes and other items', async () => {
    const useCase = buildUseCase([
      decryptedPayload('note-1', ContentType.TYPES.Note),
      decryptedPayload('key-1', ContentType.TYPES.ItemsKey),
      decryptedPayload('prefs-1', ContentType.TYPES.UserPrefs),
      decryptedPayload('tag-1', ContentType.TYPES.Tag),
    ])

    const result = await useCase.execute()

    expect(result.isFailed()).toBe(false)
    const contentTypes = result.getValue().items.map((item) => item.content_type)
    expect(contentTypes).toContain(ContentType.TYPES.Note)
    expect(contentTypes).toContain(ContentType.TYPES.Tag)
    // The key-material leak and private-noise items must NOT appear in a decrypted export.
    expect(contentTypes).not.toContain(ContentType.TYPES.ItemsKey)
    expect(contentTypes).not.toContain(ContentType.TYPES.UserPrefs)
    expect(result.getValue().items).toHaveLength(2)
  })

  it('fails when backup creation is not authorized', async () => {
    const useCase = buildUseCase([decryptedPayload('note-1', ContentType.TYPES.Note)], false)
    const result = await useCase.execute()
    expect(result.isFailed()).toBe(true)
  })

  it('fails closed when an exportable item is unreadable', async () => {
    const unreadableNote = {
      uuid: 'unreadable-note',
      content_type: ContentType.TYPES.Note,
      content: '004:unreadable-ciphertext',
      enc_item_key: '004:encrypted-item-key',
      items_key_id: 'missing-key',
      errorDecrypting: true,
      waitingForKey: false,
    }
    const sync = { getFullContentPayload: jest.fn() }
    const useCase = buildUseCase([decryptedPayload('note-1', ContentType.TYPES.Note), unreadableNote], true, sync)

    const result = await useCase.execute()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('1 item is encrypted but unreadable')
    expect(sync.getFullContentPayload).not.toHaveBeenCalled()
  })

  it('fails closed when a lite note cannot be re-hydrated', async () => {
    const liteNote = {
      ...decryptedPayload('lite-note', ContentType.TYPES.Note),
      content: { title: 'Lite note', __lazyLite: true },
    }
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(undefined) }
    const useCase = buildUseCase([liteNote], true, sync)
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await useCase.execute()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('1 item could not be read in full')
    consoleErrorSpy.mockRestore()
  })

  it('exports the complete body after successfully re-hydrating a lite note', async () => {
    const liteNote = {
      ...decryptedPayload('lite-note', ContentType.TYPES.Note),
      content: { title: 'Lite note', __lazyLite: true },
    }
    const fullNote = {
      ...decryptedPayload('lite-note', ContentType.TYPES.Note),
      content: { title: 'Lite note', text: 'Complete note body' },
    }
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(fullNote) }
    const useCase = buildUseCase([liteNote], true, sync)

    const result = await useCase.execute()

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().items).toEqual([
      expect.objectContaining({
        uuid: 'lite-note',
        content: { title: 'Lite note', text: 'Complete note body' },
      }),
    ])
  })
})
