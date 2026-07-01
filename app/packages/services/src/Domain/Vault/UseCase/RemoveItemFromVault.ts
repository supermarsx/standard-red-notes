import { MutatorClientInterface, SyncServiceInterface } from '@standardnotes/services'
import { ClientDisplayableError } from '@standardnotes/responses'
import { DecryptedItemInterface, FileItem } from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { FilesClientInterface } from '@standardnotes/files'

export class RemoveItemFromVault {
  constructor(
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private files: FilesClientInterface,
  ) {}

  async execute(dto: { item: DecryptedItemInterface }): Promise<ClientDisplayableError | void> {
    /**
     * Capture the pre-mutation vault context BEFORE clearing shared_vault_uuid. moveFileOutOfSharedVault
     * early-returns an error when the file is no longer in a shared vault, so if we read these values
     * after the mutation they would be undefined and the move would be a no-op, orphaning the blob
     * (unreadable under the new key). We also only move-out files that were in a SHARED vault; items
     * that were in a private (non-shared) vault have no remote shared-vault blob to relocate.
     */
    const wasFile = dto.item.content_type === ContentType.TYPES.File
    const originalFile = wasFile ? (dto.item as FileItem) : undefined
    const wasInSharedVault = !!originalFile?.shared_vault_uuid

    await this.mutator.changeItem(dto.item, (mutator) => {
      mutator.key_system_identifier = undefined
      mutator.shared_vault_uuid = undefined
    })

    await this.sync.sync()

    if (wasInSharedVault && originalFile) {
      /**
       * Pass the pre-mutation file (still carrying shared_vault_uuid) so the move actually runs, and
       * propagate any returned error instead of discarding it.
       */
      const moveResult = await this.files.moveFileOutOfSharedVault(originalFile)
      if (moveResult) {
        return moveResult
      }
    }
  }
}
