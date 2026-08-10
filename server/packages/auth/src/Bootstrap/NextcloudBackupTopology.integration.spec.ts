import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

describe('local SNS/SQS bootstrap execution', () => {
  it('passes SQS endpoints to SNS and routes the credential topic only to syncing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'srn-awslocal-'))
    const callLog = join(directory, 'calls.log')
    const bashHarness = `
export AWSLOCAL_CALL_LOG="$2"
awslocal() {
set -euo pipefail
printf '%s\\n' "$*" >> "$AWSLOCAL_CALL_LOG"
if [[ "$*" == *"sqs list-queues"* ]]; then echo '{"QueueUrls":[]}'
elif [[ "$*" == *"sns list-topics"* ]]; then echo '{"Topics":[]}'
elif [[ "$*" == *"sqs create-queue"* ]]; then echo '{"QueueUrl":"test"}'
elif [[ "$*" == *"sns create-topic"* ]]; then echo '{"TopicArn":"test"}'
elif [[ "$*" == *"sns subscribe"* ]]; then echo '{"SubscriptionArn":"test"}'
fi
}
source "$1"
`

    try {
      const bootstrapScript = resolve(__dirname, '../../../../docker/localstack_bootstrap.sh')
      const toWslPath = (path: string) =>
        path
          .replace(/^([A-Za-z]):[\\/]/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}/`)
          .replaceAll('\\', '/')
      const command = process.platform === 'win32' ? 'wsl.exe' : 'bash'
      const subprocessTimeoutMs = process.platform === 'win32' ? 30_000 : 10_000
      const commandArguments =
        process.platform === 'win32'
          ? [
              '--exec',
              'bash',
              '-c',
              bashHarness,
              'nextcloud-topology-test',
              toWslPath(bootstrapScript),
              toWslPath(callLog),
            ]
          : ['-c', bashHarness, 'nextcloud-topology-test', bootstrapScript, callLog]
      const result = spawnSync(command, commandArguments, {
        encoding: 'utf8',
        env: process.env,
        timeout: subprocessTimeoutMs,
        windowsHide: true,
      })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })

      const subscriptions = readFileSync(callLog, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('sns subscribe'))
      expect(subscriptions.every((line) => line.includes('--notification-endpoint arn:aws:sqs:'))).toBe(true)

      const dedicated = subscriptions.filter((line) => line.includes(':nextcloud-backup-local-topic'))
      expect(dedicated).toHaveLength(1)
      expect(dedicated[0]).toContain(
        '--notification-endpoint arn:aws:sqs:us-east-1:000000000000:syncing-server-local-queue',
      )
      expect(
        subscriptions.some(
          (line) => line.includes(':auth-local-topic') && line.includes(':syncing-server-local-queue'),
        ),
      ).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
