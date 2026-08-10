import { MutatorClientInterface, SyncServiceInterface } from '@standardnotes/services'
import { ClientDisplayableError } from '@standardnotes/responses'
import { DecryptedItemInterface, FileItem, VaultListingInterface } from '@standardnotes/models'
import { FilesClientInterface } from '@standardnotes/files'
import { ContentType } from '@standardnotes/domain-core'

export class MoveItemsToVault {
  constructor(
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private files: FilesClientInterface,
  ) {}

  async execute(dto: {
    items: DecryptedItemInterface[]
    vault: VaultListingInterface
  }): Promise<ClientDisplayableError | void> {
    let metadataNeedsSync = false

    for (const item of dto.items) {
      const targetSharedVaultUuid = dto.vault.isSharedVaultListing() ? dto.vault.sharing.sharedVaultUuid : undefined
      const metadataAlreadyAtTarget =
        item.key_system_identifier === dto.vault.systemIdentifier && item.shared_vault_uuid === targetSharedVaultUuid

      if (metadataAlreadyAtTarget) {
        // A prior attempt can have moved the blob and updated local metadata but
        // failed while syncing. Flush that dirty metadata on retry without
        // issuing a second destructive file move.
        metadataNeedsSync = true
        continue
      }

      if (item.content_type === ContentType.TYPES.File) {
        // The current files protocol exposes one destructive move, not a
        // copy/finalize transaction. Flush earlier metadata first, then move
        // this blob while the immutable input item still carries its source
        // ownership. Updating local metadata immediately afterward keeps this
        // client pointed at the destination even if the remote sync rejects;
        // a later execution recognizes that target metadata and retries only
        // the sync rather than replaying the destructive move.
        const pendingSyncError = await this.syncPendingMetadata(metadataNeedsSync)
        if (pendingSyncError) {
          return pendingSyncError
        }
        metadataNeedsSync = false

        const originalFile = item as FileItem
        const blobAlreadyAtTarget = originalFile.shared_vault_uuid === targetSharedVaultUuid

        if (!blobAlreadyAtTarget) {
          const moveError = dto.vault.isSharedVaultListing()
            ? await this.files.moveFileToSharedVault(originalFile, dto.vault)
            : await this.files.moveFileOutOfSharedVault(originalFile)

          if (moveError) {
            return moveError
          }
        }
      }

      await this.mutator.changeItem(item, (mutator) => {
        mutator.key_system_identifier = dto.vault.systemIdentifier
        mutator.shared_vault_uuid = targetSharedVaultUuid
      })
      metadataNeedsSync = true

      if (item.content_type !== ContentType.TYPES.File) {
        continue
      }

      const syncError = await this.syncPendingMetadata(metadataNeedsSync)
      if (syncError) {
        return syncError
      }
      metadataNeedsSync = false
    }

    return this.syncPendingMetadata(metadataNeedsSync)
  }

  private async syncPendingMetadata(metadataNeedsSync: boolean): Promise<ClientDisplayableError | void> {
    if (!metadataNeedsSync) {
      return
    }

    try {
      await this.sync.sync()
    } catch {
      return new ClientDisplayableError(
        'Could not save the vault move. The item remains available and the operation can be retried.',
      )
    }
  }
}
