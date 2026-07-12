import test from 'ava'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Store } from '../app/javascripts/Main/Store/Store'
import { StoreKeys } from '../app/javascripts/Main/Store/StoreKeys'

/**
 * Store.set persists desktop settings to user-preferences.json. It must write
 * atomically (temp file + rename), because parseDataFile silently resets EVERY
 * setting to defaults on a torn/partial parse — so a crash mid-write must never
 * be able to truncate the real file.
 *
 * These are pure-fs tests: Store is constructed with an explicit data path, so
 * it never touches electron.app (only Store.getInstance() would).
 */

function freshStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sn-store-'))
}

test('set persists values that survive reopening the store', (t) => {
  const dir = freshStoreDir()
  try {
    const store = new Store(dir)
    store.set(StoreKeys.ZoomFactor, 1.5)
    store.set(StoreKeys.MinimizeToTray, true)

    // Reopening reads the on-disk file: proves the atomic write actually landed.
    const reopened = new Store(dir)
    t.is(reopened.get(StoreKeys.ZoomFactor), 1.5)
    t.is(reopened.get(StoreKeys.MinimizeToTray), true)

    const onDisk = fs.readFileSync(path.join(dir, 'user-preferences.json'), 'utf8')
    t.notThrows(() => JSON.parse(onDisk))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('set writes atomically: a crash mid-write never truncates the real file', (t) => {
  const dir = freshStoreDir()
  const filePath = path.join(dir, 'user-preferences.json')
  try {
    const store = new Store(dir)

    // Establish a known-good committed file.
    store.set(StoreKeys.ZoomFactor, 2)
    const good = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    t.is(good[StoreKeys.ZoomFactor], 2)

    // Simulate power-loss mid-write: whatever path writeFileSync is handed, write
    // only a truncated fragment and then throw, as if the process died before the
    // write completed. With the pre-fix bare `writeFileSync(this.path, ...)` this
    // fragment would land ON user-preferences.json and corrupt it; the temp-file
    // + rename fix must confine the damage to the throwaway temp file and leave
    // the real file untouched.
    const realWriteFileSync = fs.writeFileSync
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync = ((p: any, data: any, ...rest: any[]) => {
      realWriteFileSync(p, String(data).slice(0, 5), ...rest)
      throw new Error('simulated power loss mid-write')
    }) as typeof fs.writeFileSync

    try {
      t.throws(() => store.set(StoreKeys.ZoomFactor, 3))
    } finally {
      fs.writeFileSync = realWriteFileSync
    }

    // The real file must still parse and still hold the last fully-committed value.
    const after = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(after) // must not throw -> not truncated
    t.is(parsed[StoreKeys.ZoomFactor], 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
