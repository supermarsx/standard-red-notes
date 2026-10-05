import { DomainEventHandlerInterface, FileQuotaRecalculatedEvent } from '@standardnotes/domain-events'
import { UpdateStorageQuotaUsedForUser } from '../UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'
import { Logger } from 'winston'

export class FileQuotaRecalculatedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private updateStorageQuota: UpdateStorageQuotaUsedForUser,
    private logger: Logger,
  ) {}

  async handle(event: FileQuotaRecalculatedEvent): Promise<void> {
    this.logger.info('Updating storage quota for user...', {
      userId: event.payload.userUuid,
      totalFileByteSize: event.payload.totalFileByteSize,
      codeTag: 'FileQuotaRecalculatedEventHandler',
    })

    /**
     * *** A RECALCULATION IS THE AUTHORITY, SO IT IS WRITTEN ABSOLUTELY. ***
     *
     * `totalFileByteSize` is what the FILES service summed from the bytes
     * actually on disk for this owner. It used to be ADDED, which was only
     * correct because `FixStorageQuotaForUser` zeroed the counter first — a
     * separate write, leaving a visible, confident `0` in between for an account
     * that holds megabytes. If the recalculation then never arrived, that zero
     * was the figure the account reported; and from the `srn-admin` CLI on a
     * single container it cannot arrive, because that boot has no event
     * transport. A fabricated zero reads as a measurement, so it is worse than
     * the absent figure it replaced.
     */
    const result = await this.updateStorageQuota.execute({
      userUuid: event.payload.userUuid,
      bytesUsed: event.payload.totalFileByteSize,
      absolute: true,
    })

    if (result.isFailed()) {
      this.logger.error('Could not update storage quota', {
        userId: event.payload.userUuid,
        codeTag: 'FileQuotaRecalculatedEventHandler',
      })

      return
    }

    this.logger.info('Storage quota updated', {
      userId: event.payload.userUuid,
      totalFileByteSize: event.payload.totalFileByteSize,
      codeTag: 'FileQuotaRecalculatedEventHandler',
    })
  }
}
