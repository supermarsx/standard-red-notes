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
  test.before(async (t) => {
    t.context = await createDriver()
  })

  test.after.always((t) => {
    return t.context.stop()
  })

  test('Only has one window', async (t) => {
    t.is(await t.context.windowCount(), 1)
  })
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a webpack build + display, not runnable headless.
  test.skip('window: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run', () => {})
}
