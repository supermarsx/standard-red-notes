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
  assert.match(section, /### Verify and recover a Nextcloud backup/)
  assert.match(section, /does not replace revision-history or attachment\/file-volume backups/)
  assert.doesNotMatch(section, /^(?:---|___|\* \* \*)\s*$/m)
  assert.doesNotMatch(section, /\b(?:plan(?:ned)?|roadmap|future capability)\b/i)
})
