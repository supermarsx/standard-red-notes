import { ContentType } from '@standardnotes/domain-core'
import { CreateEncryptedBackupFile } from './CreateEncryptedBackupFile'

// RESTORE-SAFETY GUARD: an ENCRYPTED full-account backup must stay COMPLETE — it has to keep the
// (encrypted) items key so the account can be restored, and it keeps user preferences too. Unlike
// the decrypted export, this path applies NO exportability filter. This spec pins that: every item
// (including the items key and user preferences) flows through to the backup.
const decryptedPayload = (uuid: string, contentType: string) =>
  ({
    uuid,
    content_type: contentType,
    content: { title: uuid },
  }) as never

describe('CreateEncryptedBackupFile', () => {
  it('KEEPS the items key and user preferences (complete, restorable backup)', async () => {
    const items = {
      items: [
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
  })
})
