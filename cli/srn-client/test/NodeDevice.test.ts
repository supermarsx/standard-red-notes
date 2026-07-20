/**
 * Tests for src/NodeDevice.ts — the file-backed snjs DeviceInterface.
 *
 * This is where the encrypted keychain and the item database land on disk, so
 * the properties under test are: what is written is what was in hand at call
 * time, a failed write never poisons later ones, and clearing a namespace never
 * touches a neighbouring one.
 *
 * Every case runs against a throwaway temp dir; the real ~/.srn is never opened.
 */
// MUST come first, exactly as in src/index.ts: snjs's published bundle reads the
// browser global `self` at module-evaluation time.
import '../src/polyfill.ts'

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { NodeDevice } from '../src/NodeDevice.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'srn-nodedevice-test-'))
let counter = 0

function freshDir(): string {
  return path.join(root, `d${counter++}`)
}

function device(dir = freshDir()): { device: NodeDevice; dir: string } {
  return { device: new NodeDevice(dir), dir }
}

function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
}

const ID = 'srn-client'

// --- raw storage -------------------------------------------------------------

test('raw storage round-trips through disk, not just memory', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('k', 'v')
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), { k: 'v' })

  const reopened = new NodeDevice(dir)
  assert.equal(await reopened.getRawStorageValue('k'), 'v')
})

test('an absent raw storage key reads back as undefined', async () => {
  const { device: d } = device()
  assert.equal(await d.getRawStorageValue('nope'), undefined)
})

test('getJsonParsedRawStorageValue parses JSON and falls back to the raw string', async () => {
  const { device: d } = device()
  await d.setRawStorageValue('json', '{"a":1}')
  await d.setRawStorageValue('plain', 'not json')
  assert.deepEqual(await d.getJsonParsedRawStorageValue('json'), { a: 1 })
  assert.equal(await d.getJsonParsedRawStorageValue('plain'), 'not json')
  assert.equal(await d.getJsonParsedRawStorageValue('missing'), undefined)
})

test('removeRawStorageValue deletes one key and leaves the rest', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('a', '1')
  await d.setRawStorageValue('b', '2')
  await d.removeRawStorageValue('a')
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), { b: '2' })
})

test('removeAllRawStorageValues empties the store on disk too', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('a', '1')
  await d.removeAllRawStorageValues()
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), {})
})

test('removeRawStorageValuesForIdentifier only clears the matching namespace', async () => {
  const { device: d } = device()
  await d.setRawStorageValue('srn-client-session', 'a')
  await d.setRawStorageValue('srn-client-keys', 'b')
  await d.setRawStorageValue('other-app-session', 'c')
  await d.removeRawStorageValuesForIdentifier(ID)
  assert.equal(await d.getRawStorageValue('srn-client-session'), undefined)
  assert.equal(await d.getRawStorageValue('srn-client-keys'), undefined)
  assert.equal(await d.getRawStorageValue('other-app-session'), 'c')
})

// --- database ----------------------------------------------------------------

test('openDatabase reports a brand-new database only the first time', async () => {
  const { device: d, dir } = device()
  assert.deepEqual(await d.openDatabase(ID), { isNewDatabase: true })
  await d.saveDatabaseEntry({ uuid: 'u1' }, ID)
  await d.flushWrites()
  assert.deepEqual(await new NodeDevice(dir).openDatabase(ID), { isNewDatabase: false })
})

test('openDatabase on an already-loaded device does not re-report as new', async () => {
  const { device: d } = device()
  await d.getAllDatabaseEntries(ID)
  assert.deepEqual(await d.openDatabase(ID), { isNewDatabase: false })
})

test('database entries save, read back by key and survive a reopen', async () => {
  const { device: d, dir } = device()
  await d.saveDatabaseEntries([{ uuid: 'a' }, { uuid: 'b' }], ID)
  await d.flushWrites()
  const reopened = new NodeDevice(dir)
  assert.deepEqual(await reopened.getDatabaseEntries(ID, ['b']), [{ uuid: 'b' }])
  assert.equal((await reopened.getAllDatabaseEntries(ID)).length, 2)
})

test('getDatabaseEntries silently drops keys that are not present', async () => {
  const { device: d } = device()
  await d.saveDatabaseEntry({ uuid: 'a' }, ID)
  assert.deepEqual(await d.getDatabaseEntries(ID, ['a', 'ghost']), [{ uuid: 'a' }])
})

test('saving the same uuid twice replaces rather than duplicates', async () => {
  const { device: d } = device()
  await d.saveDatabaseEntry({ uuid: 'a', v: 1 }, ID)
  await d.saveDatabaseEntry({ uuid: 'a', v: 2 }, ID)
  assert.deepEqual(await d.getAllDatabaseEntries(ID), [{ uuid: 'a', v: 2 }])
})

test('removeDatabaseEntry and removeAllDatabaseEntries reach disk', async () => {
  const { device: d, dir } = device()
  await d.saveDatabaseEntries([{ uuid: 'a' }, { uuid: 'b' }], ID)
  await d.removeDatabaseEntry('a', ID)
  await d.flushWrites()
  assert.deepEqual(Object.keys(readJson(dir, 'db.json') as object), ['b'])
  await d.removeAllDatabaseEntries(ID)
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'db.json'), {})
})

test('getDatabaseLoadChunks batches the remaining payloads by batchSize', async () => {
  const { device: d } = device()
  const notes = Array.from({ length: 7 }, (_, i) => ({ uuid: `n${i}`, content_type: 'Note' }))
  await d.saveDatabaseEntries(notes, ID)
  const result = await d.getDatabaseLoadChunks({ contentTypePriority: ['Tag'], uuidPriority: [], batchSize: 3 }, ID)
  const remaining = result.fullEntries.remainingChunks
  // First chunk is always the content-type-priority bucket; the rest are batches.
  assert.equal(remaining.length, 1 + Math.ceil(7 / 3))
  assert.deepEqual(
    remaining.slice(1).map((c) => c.entries.length),
    [3, 3, 1],
  )
  assert.equal(result.remainingChunksItemCount, 7)
})

test('getDatabaseLoadChunks separates items keys from ordinary payloads', async () => {
  const { device: d } = device()
  await d.saveDatabaseEntries(
    [
      { uuid: 'k1', content_type: 'SN|ItemsKey' },
      { uuid: 'n1', content_type: 'Note' },
    ],
    ID,
  )
  const result = await d.getDatabaseLoadChunks({ contentTypePriority: [], uuidPriority: [], batchSize: 10 }, ID)
  assert.deepEqual(
    result.fullEntries.itemsKeys.entries.map((e) => e.uuid),
    ['k1'],
  )
  assert.equal(
    result.fullEntries.itemsKeys.entries.some((e) => e.uuid === 'n1'),
    false,
  )
})

// --- keychain ----------------------------------------------------------------

test('the keychain is namespaced, so clearing one app leaves another intact', async () => {
  const { device: d, dir } = device()
  await d.setNamespacedKeychainValue({ rootKey: 'a' }, 'app-a')
  await d.setNamespacedKeychainValue({ rootKey: 'b' }, 'app-b')
  await d.clearNamespacedKeychainValue('app-a')
  await d.flushWrites()
  assert.equal(await d.getNamespacedKeychainValue('app-a'), undefined)
  assert.deepEqual(await d.getNamespacedKeychainValue('app-b'), { rootKey: 'b' })
  assert.deepEqual(readJson(dir, 'keychain.json'), { 'app-b': { rootKey: 'b' } })
})

test('clearRawKeychainValue wipes every namespace', async () => {
  const { device: d, dir } = device()
  await d.setNamespacedKeychainValue({ rootKey: 'a' }, 'app-a')
  await d.setNamespacedKeychainValue({ rootKey: 'b' }, 'app-b')
  await d.clearRawKeychainValue()
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'keychain.json'), {})
})

test('the keychain persists across a reopen of the same data dir', async () => {
  const { device: d, dir } = device()
  await d.setNamespacedKeychainValue({ rootKey: 'secret-material' }, ID)
  await d.flushWrites()
  assert.deepEqual(await new NodeDevice(dir).getNamespacedKeychainValue(ID), { rootKey: 'secret-material' })
})

// --- write serialization -----------------------------------------------------

test('a queued write records the value as it was at ENQUEUE time', async () => {
  // The bug this guards: serializing lazily let a mutation made while the write
  // was still queued change the bytes that landed, which corrupted the keychain.
  const { device: d, dir } = device()
  const value: Record<string, unknown> = { rootKey: 'first' }

  // Queue a run of writes so the interesting one sits behind real file I/O.
  // They all enqueue in the same microtask drain, so once the FIRST write's I/O
  // has completed the last one is provably queued but not yet executed.
  const writes = [
    ...Array.from({ length: 20 }, (_, i) => d.setRawStorageValue('filler', String(i))),
    d.setNamespacedKeychainValue(value, ID),
  ]
  await writes[0]
  value.rootKey = 'mutated-while-queued'

  await Promise.all(writes)
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'keychain.json'), { [ID]: { rootKey: 'first' } })
})

test('concurrent writes all land, and the last one wins on disk', async () => {
  const { device: d, dir } = device()
  // Load first: the very first call also has to mkdir and read three files, so
  // it would enqueue AFTER its siblings and the "last" write would not be i=24.
  await d.setRawStorageValue('k', 'seed')
  await Promise.all(Array.from({ length: 25 }, (_, i) => d.setRawStorageValue('k', String(i))))
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), { k: '24' })
})

test('a failing write does not poison the chain for later writes', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('before', '1')
  await d.flushWrites()

  // Make the atomic rename impossible by turning the destination into a
  // directory: the write fails, but persistence must recover afterwards.
  const blocked = path.join(dir, 'db.json')
  mkdirSync(blocked, { recursive: true })
  await assert.rejects(() => d.saveDatabaseEntry({ uuid: 'x' }, ID))

  await d.setRawStorageValue('after', '2')
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), { before: '1', after: '2' })
})

test('a failed write leaves no temp file behind', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('seed', '1')
  await d.flushWrites()
  mkdirSync(path.join(dir, 'db.json'), { recursive: true })
  await assert.rejects(() => d.saveDatabaseEntry({ uuid: 'x' }, ID))
  await d.flushWrites()
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes('.tmp')),
    [],
  )
})

test('flushWrites resolves even when the last queued write failed', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('seed', '1')
  await d.flushWrites()
  mkdirSync(path.join(dir, 'db.json'), { recursive: true })
  await d.saveDatabaseEntry({ uuid: 'x' }, ID).catch(() => {})
  await d.flushWrites()
})

// --- corrupt / hostile on-disk state ----------------------------------------

test('corrupt JSON on disk is treated as empty rather than crashing startup', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'storage.json'), '{ not json')
  writeFileSync(path.join(dir, 'keychain.json'), 'nope')
  writeFileSync(path.join(dir, 'db.json'), '[[[')
  const d = new NodeDevice(dir)
  assert.equal(await d.getRawStorageValue('anything'), undefined)
  assert.equal(await d.getNamespacedKeychainValue(ID), undefined)
  assert.deepEqual(await d.getAllDatabaseEntries(ID), [])
})

test('the data dir is created on demand', async () => {
  const dir = path.join(freshDir(), 'nested', 'deeper')
  const d = new NodeDevice(dir)
  await d.setRawStorageValue('k', 'v')
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), { k: 'v' })
})

// --- lifecycle ---------------------------------------------------------------

test('clearAllDataFromDevice wipes storage, keychain and db without killing the app', async () => {
  const { device: d, dir } = device()
  await d.setRawStorageValue('k', 'v')
  await d.setNamespacedKeychainValue({ rootKey: 'a' }, ID)
  await d.saveDatabaseEntry({ uuid: 'a' }, ID)
  assert.deepEqual(await d.clearAllDataFromDevice([ID]), { killsApplication: false })
  await d.flushWrites()
  assert.deepEqual(readJson(dir, 'storage.json'), {})
  assert.deepEqual(readJson(dir, 'keychain.json'), {})
  assert.deepEqual(readJson(dir, 'db.json'), {})
})

test('destruction is reported only after a hard reset or deinit', () => {
  const { device: d } = device()
  assert.equal(d.isDeviceDestroyed(), false)
  d.performSoftReset()
  assert.equal(d.isDeviceDestroyed(), false, 'a soft reset must not destroy the device')
  d.performHardReset()
  assert.equal(d.isDeviceDestroyed(), true)

  const { device: other } = device()
  other.deinit()
  assert.equal(other.isDeviceDestroyed(), true)
})

test('openUrl is a no-op in headless mode', () => {
  const { device: d } = device()
  assert.equal(d.openUrl('https://example.com'), undefined)
})

test('the device reports the web environment snjs expects', () => {
  const { device: d } = device()
  assert.equal(typeof d.environment, 'number')
})
