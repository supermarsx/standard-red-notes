import { DomainEventHandlerInterface, UserPermissionChangedInSharedVaultEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { UpdateSharedVaultUserPermission } from '../UseCase/UpdateSharedVaultUserPermission/UpdateSharedVaultUserPermission'

export class UserPermissionChangedInSharedVaultEventHandler implements DomainEventHandlerInterface {
  constructor(
    private updateSharedVaultUserPermission: UpdateSharedVaultUserPermission,
    private logger: Logger,
  ) {}

  async handle(event: UserPermissionChangedInSharedVaultEvent): Promise<void> {
    if (!event.payload.sharedVaultUuid) {
      this.logger.error('Shared-vault UUID is missing from the permission-changed event.', {
        userId: event.payload.userUuid,
      })

      return
    }

    const result = await this.updateSharedVaultUserPermission.execute({
      userUuid: event.payload.userUuid,
      sharedVaultUuid: event.payload.sharedVaultUuid,
      permission: event.payload.permission,
      updatedAt: event.payload.updatedAt,
    })

    if (result.isFailed()) {
      // Worth a loud log rather than a silent return: while this mirror disagrees with the
      // syncing-server, shared-vault FILE uploads are authorized from the stale value.
      this.logger.error('Failed to update a shared vault user permission.', {
        userId: event.payload.userUuid,
      })
    }
  }
}
