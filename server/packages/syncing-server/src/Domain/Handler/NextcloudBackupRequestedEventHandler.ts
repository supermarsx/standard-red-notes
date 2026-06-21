import { DomainEventHandlerInterface, NextcloudBackupRequestedEvent } from '@standardnotes/domain-events'
import { Uuid } from '@standardnotes/domain-core'
import { KeyParamsData } from '@standardnotes/responses'
import { Logger } from 'winston'

import { WebDAVItemBackupServiceInterface } from '../Item/WebDAVItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemQuery } from '../Item/ItemQuery'

/**
 * Standard Red Notes: handles NEXTCLOUD_BACKUP_REQUESTED by producing the user's
 * ALREADY end-to-end encrypted items as a single backup JSON artifact and uploading
 * it to the user's configured Nextcloud folder over WebDAV. Mirrors
 * EmailBackupRequestedEventHandler, but instead of publishing an EMAIL_REQUESTED
 * event it performs the upload directly via WebDAVItemBackupService.
 *
 * The destination + credential are carried in the event payload (resolved auth-side,
 * where the per-user settings + sensitive app password live). The server only ever
 * handles ciphertext; Nextcloud only ever receives ciphertext.
 *
 * All failures are logged and swallowed so a single user's failure never crashes the
 * batch job.
 */
export class NextcloudBackupRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private primaryItemRepository: ItemRepositoryInterface,
    private webDAVItemBackupService: WebDAVItemBackupServiceInterface,
    private logger: Logger,
  ) {}

  async handle(event: NextcloudBackupRequestedEvent): Promise<void> {
    const userUuidOrError = Uuid.create(event.payload.userUuid)
    if (userUuidOrError.isFailed()) {
      this.logger.error('User uuid is invalid', {
        userId: event.payload.userUuid,
        codeTag: 'NextcloudBackupRequestedEventHandler',
      })

      return
    }

    const itemQuery: ItemQuery = {
      userUuid: event.payload.userUuid,
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      deleted: false,
    }

    const items = await this.primaryItemRepository.findAll(itemQuery)

    const keyParams = event.payload.keyParams as unknown as KeyParamsData
    const username = (keyParams.identifier as string) ?? ''

    const fileName = await this.webDAVItemBackupService.uploadBackup(items, keyParams, {
      url: event.payload.nextcloudUrl,
      username,
      appPassword: event.payload.nextcloudAppPassword,
      folder: event.payload.nextcloudFolder,
    })

    if (fileName === null) {
      this.logger.warn('Nextcloud backup upload did not complete for user', {
        userId: event.payload.userUuid,
      })

      return
    }

    this.logger.info('Nextcloud backup uploaded for user', {
      userId: event.payload.userUuid,
    })
  }
}
