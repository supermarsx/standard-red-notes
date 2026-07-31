import { DomainEventInterface } from '@standardnotes/domain-events'

import {
  isValidDedicatedNextcloudBackupTopicArn,
  UnavailableNextcloudBackupDomainEventPublisher,
} from './NextcloudBackupDomainEventPublisher'

describe('dedicated Nextcloud backup event publisher', () => {
  const generalArn = 'arn:aws:sns:us-east-1:000000000000:auth-events'

  it('accepts a distinct SNS topic ARN across supported AWS partitions', () => {
    expect(
      isValidDedicatedNextcloudBackupTopicArn('arn:aws:sns:us-east-1:000000000000:nextcloud-backups', generalArn),
    ).toBe(true)
    expect(
      isValidDedicatedNextcloudBackupTopicArn(
        'arn:aws-us-gov:sns:us-gov-west-1:000000000000:nextcloud-backups',
        generalArn,
      ),
    ).toBe(true)
  })

  it.each([
    ['', 'missing'],
    [generalArn, 'general auth topic'],
    ['arn:aws:sqs:us-east-1:000000000000:nextcloud-backups', 'SQS queue'],
    ['https://sns.us-east-1.amazonaws.com/topic', 'URL'],
  ])('rejects %s as a dedicated credential topic (%s)', (candidate) => {
    expect(isValidDedicatedNextcloudBackupTopicArn(candidate, generalArn)).toBe(false)
  })

  it('fails closed rather than silently publishing to a general queue', async () => {
    const publisher = new UnavailableNextcloudBackupDomainEventPublisher()
    const event = {
      type: 'NEXTCLOUD_BACKUP_REQUESTED',
      payload: { nextcloudAppPassword: 'must-not-be-routed' },
      meta: { origin: 'auth', target: 'syncing-server' },
    } as unknown as DomainEventInterface

    await expect(publisher.publish(event)).rejects.toThrow('Dedicated Nextcloud backup event transport is unavailable')
  })
})
