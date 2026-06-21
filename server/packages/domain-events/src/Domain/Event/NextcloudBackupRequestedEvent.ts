import { DomainEventInterface } from './DomainEventInterface'
import { NextcloudBackupRequestedEventPayload } from './NextcloudBackupRequestedEventPayload'

export interface NextcloudBackupRequestedEvent extends DomainEventInterface {
  type: 'NEXTCLOUD_BACKUP_REQUESTED'
  payload: NextcloudBackupRequestedEventPayload
}
