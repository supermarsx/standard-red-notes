import anyTest, { TestFn } from 'ava'
import { createDriver, Driver } from './driver'

const test = anyTest as TestFn<Driver>

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
