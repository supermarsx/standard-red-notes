import assert from 'assert/strict'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import path from 'path'
import test from 'node:test'
import { fileURLToPath } from 'url'
import { electronTestSpecs, runElectronTestProcess } from './runElectronTests.mjs'

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedSpecs = [
  'test/backupsManager.spec.ts',
  'test/menus.spec.ts',
  'test/networking.spec.ts',
  'test/spellcheckerManager.spec.ts',
  'test/storage.spec.ts',
  'test/updates.spec.ts',
  'test/window.spec.ts',
]

test('the real Electron contract pins all seven suites', () => {
  assert.deepEqual(electronTestSpecs, expectedSpecs)
  assert.equal(new Set(electronTestSpecs).size, 7)
  for (const spec of electronTestSpecs) {
    assert.equal(existsSync(path.join(desktopDirectory, spec)), true, `missing Electron suite: ${spec}`)
  }
})

test('a synchronous spawn failure rejects deterministically', async () => {
  const failure = new Error('spawn failed')
  await assert.rejects(
    runElectronTestProcess(() => {
      throw failure
    }),
    (error) => error instanceof Error && error.message === 'Unable to start the Electron test runner.',
  )
})

test('an asynchronous child-process error rejects deterministically', async () => {
  const child = new EventEmitter()
  const result = runElectronTestProcess(() => child)
  child.emit('error', new Error('child failed'))

  await assert.rejects(
    result,
    (error) => error instanceof Error && error.message === 'Unable to start the Electron test runner.',
  )
})
