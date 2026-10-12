import {
  DomainEventInterface,
  DomainEventService,
  FileUploadedEvent,
  SharedVaultFileUploadedEvent,
} from '@standardnotes/domain-events'
import { safeErrorLogMetadata } from '@standardnotes/domain-core'

import type { HomeServerPublishedUpload } from './HomeServerSyncFilesAdapter'

/** The one method of the in-process publisher this needs, so a spec can stand in for it. */
export interface FileUploadEventPublisher {
  publish(event: DomainEventInterface): Promise<void>
}

/** The one logger method used here; `winston.Logger` satisfies it. */
export interface FileUploadAccountingLogger {
  error(message: string, metadata?: Record<string, unknown>): unknown
}

/**
 * Standard Red Notes: the domain event the files server's HTTP lane publishes
 * when an upload finishes, built for a file that arrived over the FILES_V1
 * socket lane instead.
 *
 * *** IT IS THE SAME EVENT, FIELD FOR FIELD, ON PURPOSE. *** `FinishUploadSession`
 * publishes `FILE_UPLOADED` for a personal file and `SHARED_VAULT_FILE_UPLOADED`
 * for a vault file, and those two events are the only writers of the usage
 * figures the quota check, the user's own space report and the admin space
 * report all read. A second, home-server-shaped notion of "a file was stored"
 * would be a second set of books; this reuses the one that exists so the two
 * lanes cannot disagree about what an upload costs.
 *
 * Returns `undefined` for a vault file whose owner is not named. The wire
 * validator refuses such a reference and the authorizer matches the owner
 * against the signed valet token, so this cannot be reached from the socket --
 * but an event charging an unnamed owner must never be the fallback.
 */
export function createFileUploadedDomainEvent(
  upload: HomeServerPublishedUpload,
  createdAt: Date,
): FileUploadedEvent | SharedVaultFileUploadedEvent | undefined {
  const fileName = upload.resource.remoteIdentifier
  const filePath = `${upload.storageOwnerUuid}/${fileName}`

  if (upload.resource.ownershipType === 'shared-vault') {
    const sharedVaultUuid = upload.resource.sharedVaultUuid
    const vaultOwnerUuid = upload.resource.sharedVaultOwnerUuid
    if (!sharedVaultUuid || !vaultOwnerUuid) {
      return undefined
    }

    return {
      type: 'SHARED_VAULT_FILE_UPLOADED',
      createdAt,
      meta: {
        correlation: { userIdentifier: sharedVaultUuid, userIdentifierType: 'shared-vault-uuid' },
        origin: DomainEventService.Files,
      },
      payload: { sharedVaultUuid, vaultOwnerUuid, filePath, fileName, fileByteSize: upload.byteSize },
    }
  }

  return {
    type: 'FILE_UPLOADED',
    createdAt,
    meta: {
      correlation: { userIdentifier: upload.storageOwnerUuid, userIdentifierType: 'uuid' },
      origin: DomainEventService.Files,
    },
    payload: { userUuid: upload.storageOwnerUuid, filePath, fileName, fileByteSize: upload.byteSize },
  }
}

/**
 * Standard Red Notes: the `onUploadPublished` hook of the home server's FILES_V1
 * adapter -- publishes the upload on the in-process bus so it is counted.
 *
 * It never throws. By the time it runs the bytes are durable and the client is
 * owed a success, so a failure to count is logged at `error` (with the redacted
 * classification only) and the figure is left for Recalculate storage quota,
 * which derives it from the files actually stored.
 */
export function createFileUploadAccountant(
  publisher: FileUploadEventPublisher,
  logger: FileUploadAccountingLogger,
  now: () => Date = () => new Date(),
): (upload: HomeServerPublishedUpload) => Promise<void> {
  return async (upload) => {
    const event = createFileUploadedDomainEvent(upload, now())
    if (!event) {
      logger.error('A file uploaded over the socket lane was stored but not counted: its vault owner is not named.')

      return
    }

    try {
      await publisher.publish(event)
    } catch (error) {
      logger.error('A file uploaded over the socket lane was stored but could not be counted.', {
        ...safeErrorLogMetadata(error),
        eventType: event.type,
      })
    }
  }
}
