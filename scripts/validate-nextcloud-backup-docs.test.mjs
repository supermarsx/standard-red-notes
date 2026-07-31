import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const documentationUrl = new URL('../docs/backups-and-recovery.md', import.meta.url)

test('Nextcloud backup documentation preserves the executable security contract', async () => {
  const documentation = await readFile(documentationUrl, 'utf8')
  const section = documentation.match(/## Nextcloud\/WebDAV backups[\s\S]*?(?=\n## )/)?.[0]

  assert.ok(section, 'Expected the Nextcloud/WebDAV backup section')
  assert.match(section, /level="danger"/)
  assert.match(section, /HTTPS and a dedicated app password are mandatory/)
  assert.match(section, /disables that schedule first[\s\S]*writes the\s+requested frequency last/)
  assert.match(section, /```mermaid/)
  assert.match(section, /validated address is pinned to the[\s\S]*outbound socket/)
  assert.match(section, /redirects are never followed/)
  assert.match(section, /one 60-second absolute deadline[\s\S]*`MKCOL`[\s\S]*`PUT`[\s\S]*response-body draining/)
  assert.match(section, /There is no automatic retry inside an upload attempt/)
  assert.match(section, /`NEXTCLOUD_BACKUP_SNS_TOPIC_ARN`/)
  assert.match(section, /must have exactly one SQS subscription:[\s\S]*syncing worker queue/)
  assert.match(section, /missing, malformed, or general-topic ARN fails backup[\s\S]*closed/i)
  assert.match(section, /cannot inspect an external topic's[\s\S]*subscription inventory/)
  assert.match(section, /compressed\/base64[\s\S]*not application-encrypted/)
  assert.match(section, /server-side encryption[\s\S]*scoped KMS key/)
  assert.match(section, /dead-letter queue[\s\S]*short and audited retention/)
  assert.match(section, /Pause scheduled Nextcloud backups during this rolling upgrade/)
  assert.match(section, /stop every Nextcloud backup cron/)
  assert.match(section, /rotate the affected Nextcloud app passwords/)
  assert.match(section, /never purge an entire queue casually[\s\S]*preserves[\s\S]*unrelated messages/)
  assert.match(section, /nextcloud_backup_user_locks\.user_uuid/)
  assert.match(section, /### Verify and recover a Nextcloud backup/)
  assert.match(section, /does not replace revision-history or attachment\/file-volume backups/)
  assert.doesNotMatch(section, /^(?:---|___|\* \* \*)\s*$/m)
  assert.doesNotMatch(section, /\b(?:plan(?:ned)?|roadmap|future capability)\b/i)
})
