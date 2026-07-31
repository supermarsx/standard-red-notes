import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

const SNS_TOPIC_ARN_PATTERN = /^arn:(?:aws|aws-cn|aws-us-gov):sns:[^:]+:\d{12}:[A-Za-z0-9_.-]+$/

export function isValidDedicatedNextcloudBackupTopicArn(
  nextcloudBackupTopicArn: string,
  generalAuthTopicArn: string,
): boolean {
  return SNS_TOPIC_ARN_PATTERN.test(nextcloudBackupTopicArn) && nextcloudBackupTopicArn !== generalAuthTopicArn
}

/** Fail closed when the dedicated credential-bearing event route is absent. */
export class UnavailableNextcloudBackupDomainEventPublisher implements DomainEventPublisherInterface {
  async publish(_event: DomainEventInterface): Promise<void> {
    throw new Error(
      'Dedicated Nextcloud backup event transport is unavailable; configure NEXTCLOUD_BACKUP_SNS_TOPIC_ARN.',
    )
  }
}
