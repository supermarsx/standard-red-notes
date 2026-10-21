const assert = require('node:assert/strict')
const { webcrypto } = require('node:crypto')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { build } = require('esbuild')

test('the maintained domain-core UUID generator bundles and runs without Node APIs', async () => {
  const result = await build({
    stdin: {
      contents: `import { UniqueEntityId } from '@standardnotes/domain-core';
        globalThis.generatedId = new UniqueEntityId().toString();
        globalThis.existingId = new UniqueEntityId('existing-id').toString();`,
      resolveDir: path.resolve(__dirname, '..'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  })
  const browser = { crypto: webcrypto }
  vm.runInNewContext(result.outputFiles[0].text, browser)
  assert.match(browser.generatedId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  assert.equal(browser.existingId, 'existing-id')
})
