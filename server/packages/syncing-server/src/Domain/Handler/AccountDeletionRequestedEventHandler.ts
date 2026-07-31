import { AccountDeletionRequestedEvent, DomainEventHandlerInterface } from '@standardnotes/domain-events'
import { safeErrorLogMetadata, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeleteSharedVaults } from '../UseCase/SharedVaults/DeleteSharedVaults/DeleteSharedVaults'
import { RemoveUserFromSharedVaults } from '../UseCase/SharedVaults/RemoveUserFromSharedVaults/RemoveUserFromSharedVaults'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'

export class AccountDeletionRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private itemRepository: ItemRepositoryInterface,
    private deleteSharedVaults: DeleteSharedVaults,
    private removeUserFromSharedVaults: RemoveUserFromSharedVaults,
    private logger: Logger,
  ) {}

  async handle(event: AccountDeletionRequestedEvent): Promise<void> {
    const userUuidOrError = Uuid.create(event.payload.userUuid)
    if (userUuidOrError.isFailed()) {
      this.logger.error('Operation failed.', {
        ...safeErrorLogMetadata(userUuidOrError.getError()),
        userId: event.payload.userUuid,
        codeTag: 'AccountDeletionRequestedEventHandler',
      })

      return
    }
    const userUuid = userUuidOrError.getValue()
    let firstFailure: Error | undefined
    const recordFailure = (operation: string, publicFailureMessage: string, error: unknown): void => {
      this.logger.error('Account deletion cleanup operation failed.', {
        ...safeErrorLogMetadata(error),
        userId: event.payload.userUuid,
        operation,
      })
      firstFailure ??= new Error(publicFailureMessage)
    }

    try {
      await this.itemRepository.deleteByUserUuidAndNotInSharedVault(userUuid)
    } catch (error) {
      recordFailure('delete-items-outside-shared-vaults', 'Failed to delete items outside shared vaults.', error)
    }

    try {
      const deletingVaultsResult = await this.deleteSharedVaults.execute({
        ownerUuid: event.payload.userUuid,
        allowSurviving: true,
      })

      if (deletingVaultsResult.isFailed()) {
        recordFailure('delete-shared-vaults', 'Failed to delete shared vaults.', deletingVaultsResult.getError())
      } else {
        const deletedSharedVaultUuids = Array.from(deletingVaultsResult.getValue().keys())

        this.logger.debug(
          `Deleting items from shared vaults: ${deletedSharedVaultUuids.map((uuid) => uuid.value).join(', ')}`,
        )

        if (deletedSharedVaultUuids.length !== 0) {
          try {
            await this.itemRepository.deleteByUserUuidInSharedVaults(userUuid, deletedSharedVaultUuids)
          } catch (error) {
            recordFailure('delete-items-from-shared-vaults', 'Failed to delete items from shared vaults.', error)
          }
        }
      }
    } catch (error) {
      recordFailure('delete-shared-vaults', 'Failed to delete shared vaults.', error)
    }

    try {
      const deletingUserFromOtherVaultsResult = await this.removeUserFromSharedVaults.execute({
        userUuid: event.payload.userUuid,
      })
      if (deletingUserFromOtherVaultsResult.isFailed()) {
        recordFailure(
          'remove-user-from-shared-vaults',
          'Failed to remove user from shared vaults.',
          deletingUserFromOtherVaultsResult.getError(),
        )
      }
    } catch (error) {
      recordFailure('remove-user-from-shared-vaults', 'Failed to remove user from shared vaults.', error)
    }

    if (firstFailure) {
      throw firstFailure
    }

    this.logger.info('Finished account cleanup', {
      userId: event.payload.userUuid,
    })
  }
}
