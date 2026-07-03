import { ProtectionsClientInterface } from './../Protection/ProtectionClientInterface'
import { ContentType, Result, UseCaseInterface } from '@standardnotes/domain-core'
import {
  BackupFile,
  CreateDecryptedBackupFileContextPayload,
  CreateEncryptedBackupFileContextPayload,
  isDecryptedPayload,
  isEncryptedPayload,
  ProtocolVersionLatest,
} from '@standardnotes/models'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { isNotUndefined } from '@standardnotes/utils'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { rehydrateLiteBackupPayloads } from './RehydrateLiteBackupPayloads'

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
    const { payloads, excludedUuids } = await rehydrateLiteBackupPayloads(
      this.payloads.nonDeletedItems.filter((item) => item.content_type !== ContentType.TYPES.ItemsKey),
      this.sync,
    )

    if (excludedUuids.length > 0) {
      /**
       * These lite notes could not be re-hydrated and were omitted rather than written body-less.
       * The UI (ArchiveManager / DataBackups pane / desktop auto-backup notifier) should surface
       * this count to the user; at minimum record it so the omission is not fully silent.
       */
      console.warn(
        `CreateDecryptedBackupFile: omitted ${excludedUuids.length} note(s) whose content could not be re-hydrated locally.`,
      )
    }

    const data: BackupFile = {
      version: ProtocolVersionLatest,
      items: payloads
        .map((payload) => {
          if (isDecryptedPayload(payload)) {
            return CreateDecryptedBackupFileContextPayload(payload)
          } else if (isEncryptedPayload(payload)) {
            return CreateEncryptedBackupFileContextPayload(payload)
          }
          return undefined
        })
        .filter(isNotUndefined),
    }

    return Result.ok(data)
  }
}
