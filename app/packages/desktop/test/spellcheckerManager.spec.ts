import anyTest, { TestFn } from 'ava'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createDriver, Driver } from './driver'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const canRunElectron =
  process.env.RUN_ELECTRON_TESTS === '1' && existsSync(path.join(currentDir, '..', 'app', 'dist', 'index.js'))

const StoreKeys = {
  SelectedSpellCheckerLanguageCodes: 'selectedSpellCheckerLanguageCodes',
}

const test = anyTest as TestFn<Driver>

if (canRunElectron) {
  test.before(async (t) => {
    t.context = await createDriver()
  })

  test.after.always(async (t) => {
    await t.context.stop()
  })

  if (process.platform === 'darwin') {
    test('does not create a manager on Mac', async (t) => {
      t.falsy(await t.context.spellchecker.manager())
    })
  } else {
    const language = 'cs'

    test("adds a clicked language menu item to the store and session's languages", async (t) => {
      await t.context.appMenu.clickLanguage(language as any)
      const data = (await t.context.storage.dataOnDisk()) as Record<string, string[]>
      t.true(data[StoreKeys.SelectedSpellCheckerLanguageCodes].includes(language))
      t.true((await t.context.spellchecker.languages()).includes(language))
    })

    test("removes a clicked language menu item to the store's and session's languages", async (t) => {
      await t.context.appMenu.clickLanguage(language as any)
      const data = (await t.context.storage.dataOnDisk()) as Record<string, string[]>
      t.false(data[StoreKeys.SelectedSpellCheckerLanguageCodes].includes(language))
      t.false((await t.context.spellchecker.languages()).includes(language))
    })
  }
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a webpack build + display, not runnable headless.
  test.skip(
    'spellcheckerManager: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run',
    () => {},
  )
}
