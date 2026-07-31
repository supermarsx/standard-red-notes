import { readFileSync } from 'fs'
import { resolve } from 'path'

const repositoryRoot = resolve(__dirname, '../../../../..')
const readRepositoryFile = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')
const count = (text: string, value: string): number => text.split(value).length - 1

describe('Nextcloud backup event topology contract', () => {
  const authContainer = readRepositoryFile('server/packages/auth/src/Bootstrap/Container.ts')
  const syncingContainer = readRepositoryFile('server/packages/syncing-server/src/Bootstrap/Container.ts')
  const authFactory = readRepositoryFile('server/packages/auth/src/Domain/Event/DomainEventFactory.ts')
  const syncingFactory = readRepositoryFile('server/packages/syncing-server/src/Domain/Event/DomainEventFactory.ts')
  const queueBootstrap = readRepositoryFile('server/docker/localstack_bootstrap.sh')
  const dockerEntrypoint = readRepositoryFile('server/docker/docker-entrypoint.sh')

  it('registers exactly one request owner in syncing and one completion owner in auth', () => {
    expect(
      count(
        syncingContainer,
        "eventHandlers.set('NEXTCLOUD_BACKUP_REQUESTED', container.get(TYPES.Sync_NextcloudBackupRequestedEventHandler))",
      ),
    ).toBe(1)
    expect(
      count(
        authContainer,
        "['NEXTCLOUD_BACKUP_COMPLETED', container.get(TYPES.Auth_NextcloudBackupCompletedEventHandler)]",
      ),
    ).toBe(1)
  })

  it('does not give auth a handler for credential-bearing request events', () => {
    expect(authContainer).not.toContain("['NEXTCLOUD_BACKUP_REQUESTED'")
    expect(syncingContainer).not.toContain("['NEXTCLOUD_BACKUP_COMPLETED'")
  })

  it('targets requests to syncing and credential-free completions back to auth', () => {
    const requestFactory = authFactory.slice(
      authFactory.indexOf('createNextcloudBackupRequestedEvent'),
      authFactory.indexOf('createAccountDeletionRequestedEvent'),
    )
    const completionFactory = syncingFactory.slice(
      syncingFactory.indexOf('createNextcloudBackupCompletedEvent'),
      syncingFactory.indexOf('createItemsChangedOnServerEvent'),
    )

    expect(requestFactory).toContain('target: DomainEventService.SyncingServer')
    expect(completionFactory).toContain('target: DomainEventService.Auth')
    expect(completionFactory).not.toMatch(/nextcloud(?:Url|Folder|AppPassword)/)
  })

  it('keeps the legacy auth-to-syncing route during the rolling upgrade', () => {
    expect(count(queueBootstrap, 'link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $AUTH_QUEUE_ARN')).toBe(1)
    expect(count(queueBootstrap, 'link_queue_and_topic $AUTH_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN')).toBe(1)
  })

  it('publishes new credential-bearing requests through the dedicated publisher only', () => {
    const triggerBinding = authContainer.slice(
      authContainer.indexOf('new TriggerNextcloudBackupForUser('),
      authContainer.indexOf('container.bind<TriggerNextcloudBackupForAllUsers>'),
    )

    expect(triggerBinding).toContain('TYPES.Auth_NextcloudBackupDomainEventPublisher')
    expect(triggerBinding).not.toContain('TYPES.Auth_DomainEventPublisher')
    expect(authContainer).toContain("env.get('NEXTCLOUD_BACKUP_SNS_TOPIC_ARN', true)")
    expect(authContainer).toContain('new UnavailableNextcloudBackupDomainEventPublisher()')
  })

  it('subscribes the dedicated topic exactly once and only to the syncing queue', () => {
    const dedicatedLinks = queueBootstrap
      .split('\n')
      .filter((line) => line.includes('link_queue_and_topic $NEXTCLOUD_BACKUP_TOPIC_ARN'))

    expect(dedicatedLinks).toEqual([
      'LINKING_RESULT=$(link_queue_and_topic $NEXTCLOUD_BACKUP_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN)',
    ])
    expect(queueBootstrap).not.toMatch(/NEXTCLOUD_BACKUP_TOPIC_ARN \$(?:AUTH|FILES|WEBSOCKET)_QUEUE_ARN/)
    expect(dockerEntrypoint).toContain(
      'AUTH_SERVER_NEXTCLOUD_BACKUP_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:nextcloud-backup-local-topic"',
    )
  })

  it('uses SQS ARNs for queue subscription endpoints', () => {
    const queueArnFunction = queueBootstrap.slice(
      queueBootstrap.indexOf('get_queue_arn_from_name()'),
      queueBootstrap.indexOf('get_topic_arn_from_name()'),
    )

    expect(queueArnFunction).toContain('arn:aws:sqs:')
    expect(queueArnFunction).not.toContain('arn:aws:sns:')
  })
})
