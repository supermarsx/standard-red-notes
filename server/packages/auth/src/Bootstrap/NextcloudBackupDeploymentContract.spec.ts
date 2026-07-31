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

  it('links auth and syncing topics in both directions for standalone SNS/SQS deployment', () => {
    expect(count(queueBootstrap, 'link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $AUTH_QUEUE_ARN')).toBe(1)
    expect(count(queueBootstrap, 'link_queue_and_topic $AUTH_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN')).toBe(1)
  })
})
