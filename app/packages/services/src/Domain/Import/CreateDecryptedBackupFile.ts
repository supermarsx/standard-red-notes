import { ProtectionsClientInterface } from './../Protection/ProtectionClientInterface'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import {
  BackupFile,
  CreateDecryptedBackupFileContextPayload,
  isDecryptedPayload,
  isEncryptedPayload,
  isItemExportable,
  ProtocolVersionLatest,
} from '@standardnotes/models'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { rehydrateLiteBackupPayloads } from './RehydrateLiteBackupPayloads'
import { Strings } from './Strings'

export class CreateDecryptedBackupFile implements UseCaseInterface<BackupFile> {
  constructor(
    private payloads: PayloadManagerInterface,
    private protections: ProtectionsClientInterface,
    private sync: Pick<SyncServiceInterface, 'getFullContentPayload'>,
  ) {}

  async execute(): Promise<Result<BackupFile>> {
    if (!(await this.protections.authorizeBackupCreation())) {
      return Result.fail('Failed to authorize backup creation')
    }

    /**
     * Re-hydrate any content-stripped (lite) note payloads to their full on-disk body so the
     * decrypted backup contains real note text, not the body-less in-memory projection. Pass-
     * through when lazy-decrypt is off.
     */
    /**
     * A DECRYPTED backup is human-consumable / plaintext, so exclude anything that must never
     * ship in the clear: the items key (a plaintext key is KEY-MATERIAL LEAK — already excluded
     * previously) AND user preferences (private settings noise). `isItemExportable` is the single
     * shared rule; the ENCRYPTED backup path (CreateEncryptedBackupFile) does NOT apply it, so a
     * full-account encrypted backup stays complete and restorable.
     */
    const exportablePayloads = this.payloads.nonDeletedItems.filter((item) => isItemExportable(item))
    const unreadablePayloads = exportablePayloads.filter(isEncryptedPayload)

    if (unreadablePayloads.length > 0) {
      return Result.fail(Strings.DecryptedBackupItemsUnreadable(unreadablePayloads.length))
    }

    const { payloads, excludedUuids } = await rehydrateLiteBackupPayloads(
      exportablePayloads.filter(isDecryptedPayload),
      this.sync,
    )

    if (excludedUuids.length > 0) {
      return Result.fail(Strings.BackupItemsUnavailable(excludedUuids.length))
    }

    const data: BackupFile = {
      version: ProtocolVersionLatest,
      items: payloads.map((payload) => CreateDecryptedBackupFileContextPayload(payload)),
    }

    return Result.ok(data)
  }
}
