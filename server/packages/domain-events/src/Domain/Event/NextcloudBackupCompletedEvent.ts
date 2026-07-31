import { DomainEventInterface } from './DomainEventInterface'
import { NextcloudBackupCompletedEventPayload } from './NextcloudBackupCompletedEventPayload'

export interface NextcloudBackupCompletedEvent extends DomainEventInterface {
  type: 'NEXTCLOUD_BACKUP_COMPLETED'
  payload: NextcloudBackupCompletedEventPayload
}
