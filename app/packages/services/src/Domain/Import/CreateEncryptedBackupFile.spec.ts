import { ContentType } from '@standardnotes/domain-core'
import { CreateEncryptedBackupFile } from './CreateEncryptedBackupFile'

// RESTORE-SAFETY GUARD: an ENCRYPTED full-account backup must stay COMPLETE — it has to keep the
// (encrypted) items key so the account can be restored, and it keeps user preferences too. Unlike
// the decrypted export, this path applies NO exportability filter. This spec pins that: every item
// (including the items key and user preferences) flows through to the backup.
const decryptedPayload = (uuid: string, contentType: string) => ({
  uuid,
  content_type: contentType,
  content: { title: uuid },
})

describe('CreateEncryptedBackupFile', () => {
  it('KEEPS the items key and user preferences (complete, restorable backup)', async () => {
    const items = {
      allTrackedItems: () => [
        { payload: decryptedPayload('note-1', ContentType.TYPES.Note) },
        { payload: decryptedPayload('key-1', ContentType.TYPES.ItemsKey) },
        { payload: decryptedPayload('prefs-1', ContentType.TYPES.UserPrefs) },
      ],
    } as never

    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(true) } as never

    // encryptSplit receives the key-lookup split; return an encrypted-shaped payload for every
    // item it was handed, so the assertion reflects exactly what was passed through (no filtering).
    const encryption = {
      encryptSplit: jest.fn(async (split: Record<string, { items: { uuid: string; content_type: string }[] }>) => {
        const all = [
          ...(split.usesRootKeyWithKeyLookup?.items ?? []),
          ...(split.usesItemsKeyWithKeyLookup?.items ?? []),
          ...(split.usesKeySystemRootKeyWithKeyLookup?.items ?? []),
        ]
        return all.map((p) => ({
          uuid: p.uuid,
          content_type: p.content_type,
          content: '004:ciphertext',
          enc_item_key: '004:enc',
          items_key_id: 'k',
        }))
      }),
      getRootKeyParams: jest.fn().mockReturnValue({ getPortableValue: () => ({ version: '004' }) }),
    } as never

    const sync = { getFullContentPayload: jest.fn() } as never

    const useCase = new CreateEncryptedBackupFile(items, protections, encryption, sync)
    const result = await useCase.execute()

    expect(result.isFailed()).toBe(false)
    const contentTypes = result.getValue().items.map((item) => item.content_type)
    // The encrypted backup MUST remain complete for a round-trip restore.
    expect(contentTypes).toContain(ContentType.TYPES.ItemsKey)
    expect(contentTypes).toContain(ContentType.TYPES.UserPrefs)
    expect(contentTypes).toContain(ContentType.TYPES.Note)
    expect(result.getValue().items).toHaveLength(3)
    expect(result.getValue()).toMatchObject({
      version: '004',
      keyParams: { version: '004' },
    })
  })

  it('preserves unreadable ciphertext instead of silently omitting it', async () => {
    const unreadablePayload = {
      uuid: 'unreadable-note',
      content_type: ContentType.TYPES.Note,
      content: '004:unreadable-ciphertext',
      enc_item_key: '004:encrypted-item-key',
      items_key_id: 'missing-key',
      errorDecrypting: true,
      waitingForKey: false,
    }
    const items = {
      allTrackedItems: () => [
        { payload: decryptedPayload('readable-note', ContentType.TYPES.Note) },
        { payload: unreadablePayload },
      ],
    } as never
    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(true) } as never
    const encryption = {
      encryptSplit: jest.fn().mockResolvedValue([
        {
          uuid: 'readable-note',
          content_type: ContentType.TYPES.Note,
          content: '004:readable-ciphertext',
          enc_item_key: '004:encrypted-item-key',
          items_key_id: 'key-1',
        },
      ]),
      getRootKeyParams: jest.fn().mockReturnValue(undefined),
    } as never
    const sync = { getFullContentPayload: jest.fn() } as never

    const result = await new CreateEncryptedBackupFile(items, protections, encryption, sync).execute()

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: 'unreadable-note',
          content: '004:unreadable-ciphertext',
          enc_item_key: '004:encrypted-item-key',
          items_key_id: 'missing-key',
        }),
      ]),
    )
    expect(result.getValue().items).toHaveLength(2)
  })

  it('fails closed when a lite payload cannot be re-hydrated', async () => {
    const litePayload = {
      ...decryptedPayload('lite-note', ContentType.TYPES.Note),
      content: { title: 'Lite note', __lazyLite: true },
    }
    const items = {
      allTrackedItems: () => [{ payload: litePayload }],
    } as never
    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(true) } as never
    const encryption = {
      encryptSplit: jest.fn(),
      getRootKeyParams: jest.fn(),
    }
    const sync = { getFullContentPayload: jest.fn().mockResolvedValue(undefined) } as never
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await new CreateEncryptedBackupFile(items, protections, encryption as never, sync).execute()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('1 item could not be read in full')
    expect(encryption.encryptSplit).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('fails closed if encryption omits an input payload from its output', async () => {
    const items = {
      allTrackedItems: () => [{ payload: decryptedPayload('note-1', ContentType.TYPES.Note) }],
    } as never
    const protections = { authorizeBackupCreation: jest.fn().mockResolvedValue(true) } as never
    const encryption = {
      encryptSplit: jest.fn().mockResolvedValue([]),
      getRootKeyParams: jest.fn(),
    } as never
    const sync = { getFullContentPayload: jest.fn() } as never

    const result = await new CreateEncryptedBackupFile(items, protections, encryption, sync).execute()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('1 item was missing from the generated output')
  })
})
