import anyTest, { TestFn } from 'ava'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AppName } from '../app/javascripts/Main/Strings'
import { createDriver, Driver } from './driver'
import { TestMenuItemSnapshot } from './TestIpcMessage'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const canRunElectron =
  process.env.RUN_ELECTRON_TESTS === '1' && existsSync(path.join(currentDir, '..', 'app', 'dist', 'index.js'))

const test = anyTest as TestFn<{
  driver: Driver
  menuItems: TestMenuItemSnapshot[]
}>

function findSpellCheckerLanguagesMenu(menuItems: TestMenuItemSnapshot[]) {
  const editMenu = menuItems.find((item) => item.role?.toLowerCase() === 'editmenu')
  return editMenu?.submenu?.find((item) => item.id === 'SpellcheckerLanguages')
}

if (canRunElectron) {
  test.before(async (t) => {
    t.context.driver = await createDriver()
  })

  test.after.always(async (t) => {
    await t.context.driver.stop()
  })

  test.beforeEach(async (t) => {
    t.context.menuItems = await t.context.driver.appMenu.items()
  })

  if (process.platform === 'darwin') {
    test('shows the App menu on Mac', (t) => {
      t.is(t.context.menuItems[0].role?.toLowerCase(), 'appmenu')
      t.is(t.context.menuItems[0].label, AppName)
    })

    test('hides the spellchecking submenu on Mac', (t) => {
      t.falsy(findSpellCheckerLanguagesMenu(t.context.menuItems))
    })
  } else {
    test('hides the App menu on Windows/Linux', (t) => {
      t.is(t.context.menuItems[0].role?.toLowerCase(), 'editmenu')
    })

    test('shows the spellchecking submenu on Windows/Linux', (t) => {
      const menu = findSpellCheckerLanguagesMenu(t.context.menuItems)
      t.truthy(menu)
      t.true((menu?.submenu?.length ?? 0) > 0)
    })
  }
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a webpack build + display, not runnable headless.
  test.skip('menus: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run', () => {})
}
