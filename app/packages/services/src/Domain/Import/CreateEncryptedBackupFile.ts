import { ItemManagerInterface } from './../Item/ItemManagerInterface'
import { ProtectionsClientInterface } from './../Protection/ProtectionClientInterface'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { BackupFile, CreateEncryptedBackupFileContextPayload, ProtocolVersionLatest } from '@standardnotes/models'
import { CreateEncryptionSplitWithKeyLookup, SplitPayloadsByEncryptionType } from '@standardnotes/encryption'
import { EncryptionProviderInterface } from '../Encryption/EncryptionProviderInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { rehydrateLiteBackupPayloads } from './RehydrateLiteBackupPayloads'

export class CreateEncryptedBackupFile implements UseCaseInterface<BackupFile> {
  constructor(
    private items: ItemManagerInterface,
    private protections: ProtectionsClientInterface,
    private encryption: EncryptionProviderInterface,
    private sync: Pick<SyncServiceInterface, 'getFullContentPayload'>,
  ) {}

  async execute(params: { skipAuthorization: boolean } = { skipAuthorization: false }): Promise<Result<BackupFile>> {
    if (!params.skipAuthorization && !(await this.protections.authorizeBackupCreation())) {
      return Result.fail('Failed to authorize backup creation')
    }

    /**
     * Re-hydrate any content-stripped (lite) note payloads to their full on-disk body before
     * encrypting them into the backup. Without this, a backup created while lazy-decrypt is on
     * would contain body-less notes. Pass-through when the flag is off.
     */
    const payloads = await rehydrateLiteBackupPayloads(
      this.items.items.map((item) => item.payload),
      this.sync,
    )

    const split = SplitPayloadsByEncryptionType(payloads)

    const keyLookupSplit = CreateEncryptionSplitWithKeyLookup(split)

    const result = await this.encryption.encryptSplit(keyLookupSplit)

    const ejected = result.map((payload) => CreateEncryptedBackupFileContextPayload(payload))

    const data: BackupFile = {
      version: ProtocolVersionLatest,
      items: ejected,
    }

    const keyParams = this.encryption.getRootKeyParams()
    data.keyParams = keyParams?.getPortableValue()
    return Result.ok(data)
  }
}
