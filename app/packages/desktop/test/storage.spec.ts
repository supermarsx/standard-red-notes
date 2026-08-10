import anyTest, { ExecutionContext, TestFn } from 'ava'
import fs, { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { serializeStoreData } from '../app/javascripts/Main/Store/createSanitizedStoreData'
import { timeout } from '../app/javascripts/Main/Utils/Utils'
import { createDriver, Driver } from './driver'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const canRunElectron =
  process.env.RUN_ELECTRON_TESTS === '1' && existsSync(path.join(currentDir, '..', 'app', 'dist', 'index.js'))

const test = anyTest as TestFn<Driver>

if (canRunElectron) {
  async function validateData(t: ExecutionContext<Driver>) {
    const data = await t.context.storage.dataOnDisk()

    /** If a persisted default is intentionally added or removed, update this number. */
    const numberOfStoreKeys = 10
    t.is(Object.keys(data).length, numberOfStoreKeys)

    t.is(typeof data.isMenuBarVisible, 'boolean')

    t.is(typeof data.useSystemMenuBar, 'boolean')

    t.is(typeof data.minimizeToTray, 'boolean')

    t.is(typeof data.enableAutoUpdates, 'boolean')
    t.false(data.enableAutoUpdates)

    t.is(typeof data.notifyUpdates, 'boolean')

    t.is(typeof data.zoomFactor, 'number')
    t.true(data.zoomFactor > 0)

    t.is(typeof data.extServerHost, 'string')
    /** Must not throw */
    const extServerHost = new URL(data.extServerHost)
    t.is(extServerHost.hostname, '127.0.0.1')
    t.is(extServerHost.protocol, 'http:')
    t.is(extServerHost.port, '45653')

    if (process.platform === 'linux') {
      /** Linux probes Secret Service during startup and persists whether native keychain access succeeded. */
      t.is(typeof data.useNativeKeychain, 'boolean')
    } else {
      t.is(data.useNativeKeychain, null)
    }

    t.is(typeof data.LastRunVersion, 'string')

    if (process.platform === 'darwin') {
      t.is(data.selectedSpellCheckerLanguageCodes, null)
    } else {
      t.true(Array.isArray(data.selectedSpellCheckerLanguageCodes))
      for (const language of data.selectedSpellCheckerLanguageCodes) {
        t.is(typeof language, 'string')
      }
    }
  }

  test.beforeEach(async (t) => {
    t.context = await createDriver()
  })
  test.afterEach.always((t) => {
    return t.context.stop()
  })

  test('has valid data', async (t) => {
    await validateData(t)
  })

  test('recreates a missing data file', async (t) => {
    const location = await t.context.storage.dataLocation()
    /** Delete the store's backing file */
    await fs.promises.unlink(location)
    await t.context.restart()
    await validateData(t)
  })

  test('recovers from corrupted data', async (t) => {
    const location = await t.context.storage.dataLocation()
    /** Write bad data in the store's file */
    await fs.promises.writeFile(location, '￿'.repeat(300))
    await t.context.restart()
    await validateData(t)
  })

  test('persists changes to disk after setting a value', async (t) => {
    const factor = 4.8
    await t.context.storage.setZoomFactor(factor)
    const diskData = await t.context.storage.dataOnDisk()
    t.is(diskData.zoomFactor, factor)
  })

  test('serializes string sets to an array', (t) => {
    t.deepEqual(
      serializeStoreData({
        set: new Set(['value']),
      } as any),
      JSON.stringify({
        set: ['value'],
      }),
    )
  })

  test('clears renderer local storage through the current device API', async (t) => {
    await t.context.storage.setLocalStorageValue('foo', 'bar')
    t.is(await t.context.storage.getLocalStorageValue('foo'), 'bar')

    await timeout(1_000)
    await t.context.window.clearRendererStorage()
    await timeout(1_000)
    t.is(await t.context.storage.getLocalStorageValue('foo'), null)
  })
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a build + display, not runnable headless.
  test.skip('storage: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run', () => {})
}
