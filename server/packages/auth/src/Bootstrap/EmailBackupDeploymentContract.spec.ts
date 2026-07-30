import { readFileSync } from 'fs'
import { resolve } from 'path'

const repositoryRoot = resolve(__dirname, '../../../../..')
const readRepositoryFile = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')
const count = (text: string, value: string): number => text.split(value).length - 1

describe('email backup deployment contract', () => {
  it('gives auth and syncing the same owned local backup root and byte limit', () => {
    const compose = readRepositoryFile('docker-compose.yml')
    const entrypoint = readRepositoryFile('server/docker/docker-entrypoint.sh')

    expect(compose).toContain('AUTH_SERVER_FILE_UPLOAD_PATH: /opt/shared/uploads')
    expect(compose).toContain('SYNCING_SERVER_FILE_UPLOAD_PATH: /opt/shared/uploads')
    expect(compose).toContain('AUTH_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE: ${EMAIL_ATTACHMENT_MAX_BYTE_SIZE:-10485760}')
    expect(compose).toContain(
      'SYNCING_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE: ${EMAIL_ATTACHMENT_MAX_BYTE_SIZE:-10485760}',
    )
    expect(entrypoint).toContain('export AUTH_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"')
    expect(entrypoint).toContain('export SYNCING_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"')
  })

  it('prefixes every standalone SMTP and optional S3 setting for its owning service', () => {
    const compose = readRepositoryFile('docker-compose.yml')

    for (const setting of ['HOST', 'PORT', 'USER', 'PASS', 'FROM']) {
      expect(compose).toContain(`AUTH_SERVER_SMTP_${setting}: \${SMTP_${setting}:-`)
    }
    expect(compose).toContain('AUTH_SERVER_EMAIL_BACKUPS_ENABLED: ${EMAIL_BACKUPS_ENABLED:-false}')

    for (const service of ['AUTH_SERVER', 'SYNCING_SERVER']) {
      for (const setting of ['AWS_REGION', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'BACKUP_BUCKET_NAME']) {
        expect(compose).toContain(`${service}_S3_${setting}: \${S3_${setting}:-}`)
      }
    }
  })

  it('passes direct SMTP settings into the all-in-one home-server process', () => {
    const compose = readRepositoryFile('docker-compose.single.yml')

    for (const setting of ['HOST', 'PORT', 'USER', 'PASS', 'FROM']) {
      expect(compose).toContain(`SMTP_${setting}: \${SMTP_${setting}:-`)
    }
    expect(compose).toContain('EMAIL_BACKUPS_ENABLED: ${EMAIL_BACKUPS_ENABLED:-false}')
    expect(compose).toContain('EMAIL_ATTACHMENT_MAX_BYTE_SIZE: ${EMAIL_ATTACHMENT_MAX_BYTE_SIZE:-10485760}')
  })

  it('has exactly one delivery owner in both queued and direct-call event topologies', () => {
    const authContainer = readRepositoryFile('server/packages/auth/src/Bootstrap/Container.ts')
    const syncingContainer = readRepositoryFile('server/packages/syncing-server/src/Bootstrap/Container.ts')
    const queueBootstrap = readRepositoryFile('server/docker/localstack_bootstrap.sh')

    expect(count(authContainer, "['EMAIL_REQUESTED', container.get(TYPES.Auth_EmailRequestedEventHandler)]")).toBe(1)
    expect(
      count(
        syncingContainer,
        "eventHandlers.set('EMAIL_BACKUP_REQUESTED', container.get(TYPES.Sync_EmailBackupRequestedEventHandler))",
      ),
    ).toBe(1)
    expect(
      count(queueBootstrap, 'LINKING_RESULT=$(link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $AUTH_QUEUE_ARN)'),
    ).toBe(1)
  })
})
