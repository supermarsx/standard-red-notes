import anyTest, { TestFn } from 'ava'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createDriver, Driver } from './driver'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const canRunElectron =
  process.env.RUN_ELECTRON_TESTS === '1' && existsSync(path.join(currentDir, '..', 'app', 'dist', 'index.js'))

const test = anyTest as TestFn<Driver>

if (canRunElectron) {
  test.beforeEach(async (t) => {
    t.context = await createDriver()
  })

  test.afterEach.always(async (t) => {
    await t.context.stop()
  })

  test('has auto-updates disabled by default', async (t) => {
    // Auto-update (download + install) is opt-in; it must default to off so the
    // app never downloads or installs updates without explicit user consent.
    t.false(await t.context.updates.autoUpdateEnabled())
  })

  test('reloads the menu after checking for an update', async (t) => {
    await t.context.updates.check()
    t.true(await t.context.appMenu.hasReloaded())
  })
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a webpack build + display, not runnable headless.
  test.skip('updates: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run', () => {})
}
