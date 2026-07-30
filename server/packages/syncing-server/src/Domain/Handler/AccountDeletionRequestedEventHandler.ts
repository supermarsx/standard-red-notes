import { AccountDeletionRequestedEvent, DomainEventHandlerInterface } from '@standardnotes/domain-events'
import { Uuid } from '@standardnotes/domain-core'
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
      this.logger.error(userUuidOrError.getError(), {
        userId: event.payload.userUuid,
        codeTag: 'AccountDeletionRequestedEventHandler',
      })

      return
    }
    const userUuid = userUuidOrError.getValue()
    let firstFailure: Error | undefined
    const recordFailure = (message: string): void => {
      this.logger.error(message, {
        userId: event.payload.userUuid,
      })
      firstFailure ??= new Error(message)
    }
    const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

    try {
      await this.itemRepository.deleteByUserUuidAndNotInSharedVault(userUuid)
    } catch (error) {
      recordFailure(`Failed to delete items outside shared vaults: ${describeError(error)}`)
    }

    try {
      const deletingVaultsResult = await this.deleteSharedVaults.execute({
        ownerUuid: event.payload.userUuid,
        allowSurviving: true,
      })

      if (deletingVaultsResult.isFailed()) {
        recordFailure(`Failed to delete shared vaults: ${deletingVaultsResult.getError()}`)
      } else {
        const deletedSharedVaultUuids = Array.from(deletingVaultsResult.getValue().keys())

        this.logger.debug(
          `Deleting items from shared vaults: ${deletedSharedVaultUuids.map((uuid) => uuid.value).join(', ')}`,
        )

        if (deletedSharedVaultUuids.length !== 0) {
          try {
            await this.itemRepository.deleteByUserUuidInSharedVaults(userUuid, deletedSharedVaultUuids)
          } catch (error) {
            recordFailure(`Failed to delete items from shared vaults: ${describeError(error)}`)
          }
        }
      }
    } catch (error) {
      recordFailure(`Failed to delete shared vaults: ${describeError(error)}`)
    }

    try {
      const deletingUserFromOtherVaultsResult = await this.removeUserFromSharedVaults.execute({
        userUuid: event.payload.userUuid,
      })
      if (deletingUserFromOtherVaultsResult.isFailed()) {
        recordFailure(`Failed to remove user from shared vaults: ${deletingUserFromOtherVaultsResult.getError()}`)
      }
    } catch (error) {
      recordFailure(`Failed to remove user from shared vaults: ${describeError(error)}`)
    }

    if (firstFailure) {
      throw firstFailure
    }

    this.logger.info('Finished account cleanup', {
      userId: event.payload.userUuid,
    })
  }
}
