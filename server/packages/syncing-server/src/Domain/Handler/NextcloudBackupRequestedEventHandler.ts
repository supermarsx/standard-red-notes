import {
  DomainEventHandlerInterface,
  DomainEventPublisherInterface,
  DomainEventService,
  NextcloudBackupRequestedEvent,
} from '@standardnotes/domain-events'
import { Uuid } from '@standardnotes/domain-core'
import { KeyParamsData } from '@standardnotes/responses'
import { v5 as uuidv5 } from 'uuid'
import { Logger } from 'winston'

import { WebDAVItemBackupServiceInterface } from '../Item/WebDAVItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemQuery } from '../Item/ItemQuery'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'

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
 * Item and upload failures become an explicit failed completion so one user never
 * crashes the batch job. Completion-publication failures deliberately propagate:
 * queued delivery must retry until auth can observe the outcome.
 */
export class NextcloudBackupRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private primaryItemRepository: ItemRepositoryInterface,
    private webDAVItemBackupService: WebDAVItemBackupServiceInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private logger: Logger,
  ) {}

  async handle(event: NextcloudBackupRequestedEvent): Promise<void> {
    const payload = event?.payload
    if (!payload) {
      this.logInvalidRequest()

      return
    }

    const userUuidOrError = Uuid.create(payload.userUuid)
    const eventCreatedAt = this.resolveEventCreatedAt(event)
    if (userUuidOrError.isFailed() || eventCreatedAt === null) {
      this.logInvalidRequest()

      return
    }

    const requestUuid = this.resolveRequestUuid(event, eventCreatedAt)
    if (requestUuid === null) {
      this.logInvalidRequest()

      return
    }

    let outcome: 'succeeded' | 'failed' = 'failed'
    try {
      const itemQuery: ItemQuery = {
        userUuid: event.payload.userUuid,
        sortBy: 'updated_at_timestamp',
        sortOrder: 'ASC',
        deleted: false,
      }

      const items = await this.primaryItemRepository.findAll(itemQuery)

      const keyParams = event.payload.keyParams as unknown as KeyParamsData
      const username = (keyParams.identifier as string) ?? ''

      const fileName = await this.webDAVItemBackupService.uploadBackup(
        items,
        keyParams,
        {
          url: event.payload.nextcloudUrl,
          username,
          appPassword: event.payload.nextcloudAppPassword,
          folder: event.payload.nextcloudFolder,
        },
        { artifactDate: eventCreatedAt.substring(0, 10) },
      )

      if (fileName !== null) {
        outcome = 'succeeded'
        this.logger.info('Nextcloud backup uploaded for user', {
          userId: event.payload.userUuid,
          requestId: requestUuid,
        })
      } else {
        this.logger.warn('Nextcloud backup upload did not complete for user', {
          userId: event.payload.userUuid,
          requestId: requestUuid,
        })
      }
    } catch {
      this.logger.error('Nextcloud backup processing failed for user.', {
        userId: event.payload.userUuid,
        requestId: requestUuid,
        codeTag: 'NextcloudBackupRequestedEventHandler',
      })
    }

    // Do not swallow acknowledgement publication failures. Queue redelivery is
    // preferable to an auth-side request remaining active without an outcome;
    // the destination filename is deterministic for the day, so redelivery
    // overwrites the same encrypted artifact.
    await this.domainEventPublisher.publish(
      this.domainEventFactory.createNextcloudBackupCompletedEvent({
        userUuid: event.payload.userUuid,
        requestUuid,
        outcome,
      }),
    )
  }

  /**
   * Auth versions predating acknowledgement IDs emitted otherwise valid
   * requests without requestUuid. The original event timestamp and correlation
   * survive queue redelivery, so a UUIDv5 over those immutable fields gives the
   * legacy event one stable acknowledgement identity. A supplied but malformed
   * ID is never treated as legacy.
   */
  private resolveRequestUuid(event: NextcloudBackupRequestedEvent, eventCreatedAt: string): string | null {
    const suppliedRequestUuid = (event.payload as { requestUuid?: unknown }).requestUuid
    const correlation = event.meta?.correlation
    if (
      event.meta?.origin !== DomainEventService.Auth ||
      correlation?.userIdentifierType !== 'uuid' ||
      correlation.userIdentifier !== event.payload.userUuid ||
      (event.meta.target !== undefined && event.meta.target !== DomainEventService.SyncingServer)
    ) {
      return null
    }

    if (suppliedRequestUuid !== undefined) {
      if (
        event.meta.target !== DomainEventService.SyncingServer ||
        typeof suppliedRequestUuid !== 'string' ||
        Uuid.create(suppliedRequestUuid).isFailed()
      ) {
        return null
      }

      return suppliedRequestUuid
    }

    const legacyEventIdentity = [
      'standard-red-notes:nextcloud-backup-request',
      event.payload.userUuid,
      eventCreatedAt,
      correlation.userIdentifierType,
      correlation.userIdentifier,
    ].join('|')

    return uuidv5(legacyEventIdentity, uuidv5.URL)
  }

  private resolveEventCreatedAt(event: NextcloudBackupRequestedEvent): string | null {
    if (!(event.createdAt instanceof Date) || Number.isNaN(event.createdAt.getTime())) {
      return null
    }

    return event.createdAt.toISOString()
  }

  private logInvalidRequest(): void {
    this.logger.error('Nextcloud backup request identifiers are invalid.', {
      codeTag: 'NextcloudBackupRequestedEventHandler',
    })
  }
}
