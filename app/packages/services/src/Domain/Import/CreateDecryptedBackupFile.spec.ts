import { ContentType } from '@standardnotes/domain-core'
import { CreateDecryptedBackupFile } from './CreateDecryptedBackupFile'

// The decrypted backup is human-consumable / plaintext output, so it must NOT carry an items key
// (a plaintext items key is key-material leak) or user preferences (private settings noise). Plain
// object payloads are enough: isDecryptedPayload only checks that `content` is an object, and
// nothing here is a lite payload so re-hydration is a pass-through.
const decryptedPayload = (uuid: string, contentType: string) =>
  ({
    uuid,
    content_type: contentType,
    content: { title: uuid },
  }) as never

describe('CreateDecryptedBackupFile', () => {
  const buildUseCase = (nonDeletedItems: unknown[], authorized = true) => {
    const payloads = { nonDeletedItems } as never
    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(authorized) } as never
    const sync = { getFullContentPayload: jest.fn() } as never
    return new CreateDecryptedBackupFile(payloads, protections, sync)
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
})
