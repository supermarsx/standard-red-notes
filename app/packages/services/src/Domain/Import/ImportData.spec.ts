import {
  BackupFile,
  DecryptedPayload,
  EncryptedPayload,
  FillItemContent,
  PayloadSource,
  PayloadTimestampDefaults,
  DecryptedPayloadInterface,
  EncryptedPayloadInterface,
} from '@standardnotes/models'
import { ContentType, Result } from '@standardnotes/domain-core'
import { ProtocolVersion } from '@standardnotes/common'

import { ImportData } from './ImportData'

describe('ImportData', () => {
  let items: any
  let sync: any
  let protections: any
  let encryption: any
  let payloads: any
  let history: any
  let decryptBackupFile: any
  let getFilePassword: any

  let useCase: ImportData

  const createDecryptedPayload = (uuid: string): DecryptedPayloadInterface => {
    return new DecryptedPayload(
      {
        uuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent({ title: 'decrypted note' } as any),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )
  }

  const createEncryptedPayload = (uuid: string, keySystemIdentifier?: string): EncryptedPayloadInterface => {
    return new EncryptedPayload(
      {
        uuid,
        content_type: ContentType.TYPES.Note,
        // Must carry a valid protocol-version prefix to construct an EncryptedPayload.
        content: '004:fake-ciphertext',
        enc_item_key: '004:fake-enc-item-key',
        items_key_id: 'some-items-key-id',
        errorDecrypting: true,
        waitingForKey: true,
        key_system_identifier: keySystemIdentifier,
        ...PayloadTimestampDefaults(),
      } as any,
      PayloadSource.Constructor,
    )
  }

  beforeEach(() => {
    items = {
      findItems: jest.fn().mockReturnValue([]),
    }
    sync = {
      sync: jest.fn().mockResolvedValue(undefined),
    }
    protections = {
      authorizeFileImport: jest.fn().mockResolvedValue(true),
    }
    encryption = {
      supportedVersions: jest.fn().mockReturnValue([]),
      getUserVersion: jest.fn().mockReturnValue(undefined),
    }
    payloads = {
      importPayloads: jest.fn().mockResolvedValue([]),
    }
    history = {
      getHistoryMapCopy: jest.fn().mockReturnValue({}),
    }
    decryptBackupFile = {
      execute: jest.fn(),
    }
    getFilePassword = {
      execute: jest.fn().mockResolvedValue(Result.ok('password')),
    }

    useCase = new ImportData(
      items,
      sync,
      protections,
      encryption,
      payloads,
      history,
      decryptBackupFile,
      getFilePassword,
    )
  })

  const backupFile = (): BackupFile => {
    return { items: [] } as unknown as BackupFile
  }

  it('imports an un-decryptable non-vault payload as encrypted rather than dropping it', async () => {
    const decrypted = createDecryptedPayload('decrypted-uuid')
    const undecryptableNonVault = createEncryptedPayload('encrypted-non-vault-uuid')

    decryptBackupFile.execute.mockResolvedValue(Result.ok([decrypted, undecryptableNonVault]))

    const result = await useCase.execute(backupFile())

    expect(result.isFailed()).toBe(false)

    // The encrypted non-vault payload must be passed to importPayloads (not dropped).
    const importedPayloads = payloads.importPayloads.mock.calls[0][0]
    const importedUuids = importedPayloads.map((p: any) => p.uuid)
    expect(importedUuids).toContain('decrypted-uuid')
    expect(importedUuids).toContain('encrypted-non-vault-uuid')
    expect(importedPayloads).toHaveLength(2)

    const value = result.getValue()
    // Nothing silently dropped -> no decrypt-error count.
    expect(value.errorCount).toBe(0)
    // Surfaced as imported-still-encrypted.
    expect(value.encryptedItemUuids).toEqual(['encrypted-non-vault-uuid'])
  })

  it('still imports vault-scoped encrypted payloads and reports them as encrypted', async () => {
    const vaulted = createEncryptedPayload('vault-uuid', 'vault-id')

    decryptBackupFile.execute.mockResolvedValue(Result.ok([vaulted]))

    const result = await useCase.execute(backupFile())

    const importedUuids = payloads.importPayloads.mock.calls[0][0].map((p: any) => p.uuid)
    expect(importedUuids).toEqual(['vault-uuid'])
    expect(result.getValue().encryptedItemUuids).toEqual(['vault-uuid'])
  })

  it('reports no encrypted uuids when everything decrypts', async () => {
    decryptBackupFile.execute.mockResolvedValue(Result.ok([createDecryptedPayload('a'), createDecryptedPayload('b')]))

    const result = await useCase.execute(backupFile())

    expect(result.getValue().encryptedItemUuids).toEqual([])
    expect(result.getValue().errorCount).toBe(0)
    expect(payloads.importPayloads.mock.calls[0][0]).toHaveLength(2)
  })

  it.each([ProtocolVersion.V001, ProtocolVersion.V002, ProtocolVersion.V003, ProtocolVersion.V004])(
    'accepts registered native backup protocol %s',
    async (version) => {
      encryption.supportedVersions.mockReturnValue([
        ProtocolVersion.V001,
        ProtocolVersion.V002,
        ProtocolVersion.V003,
        ProtocolVersion.V004,
      ])
      decryptBackupFile.execute.mockResolvedValue(Result.ok([]))

      const result = await useCase.execute({ version, items: [] })

      expect(result.isFailed()).toBe(false)
      expect(decryptBackupFile.execute).toHaveBeenCalled()
      expect(payloads.importPayloads).toHaveBeenCalledWith([], {})
    },
  )

  it('rejects an unsupported backup version before decrypting or authorizing import', async () => {
    encryption.supportedVersions.mockReturnValue([
      ProtocolVersion.V001,
      ProtocolVersion.V002,
      ProtocolVersion.V003,
      ProtocolVersion.V004,
    ])

    const result = await useCase.execute({ version: '999' as ProtocolVersion, items: [] })

    expect(result.isFailed()).toBe(true)
    expect(decryptBackupFile.execute).not.toHaveBeenCalled()
    expect(protections.authorizeFileImport).not.toHaveBeenCalled()
  })

  it('rejects a 004 backup when the destination account is still 003', async () => {
    encryption.supportedVersions.mockReturnValue([
      ProtocolVersion.V001,
      ProtocolVersion.V002,
      ProtocolVersion.V003,
      ProtocolVersion.V004,
    ])
    encryption.getUserVersion.mockReturnValue(ProtocolVersion.V003)

    const result = await useCase.execute({ version: ProtocolVersion.V004, items: [] })

    expect(result.isFailed()).toBe(true)
    expect(decryptBackupFile.execute).not.toHaveBeenCalled()
  })

  it('accepts a versionless pre-003 envelope and recognizes legacy auth_params', async () => {
    decryptBackupFile.execute.mockResolvedValue(Result.ok([]))
    const legacyBackup = {
      auth_params: {
        email: 'legacy@example.test',
        pw_cost: 110_000,
        pw_nonce: 'nonce',
        pw_salt: 'salt',
        version: ProtocolVersion.V002,
      },
      items: [],
    } as BackupFile

    const result = await useCase.execute(legacyBackup)

    expect(result.isFailed()).toBe(false)
    expect(getFilePassword.execute).toHaveBeenCalledTimes(1)
    expect(decryptBackupFile.execute).toHaveBeenCalledWith(legacyBackup, 'password')
  })
})
