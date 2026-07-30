import anyTest, { TestFn } from 'ava'
import { existsSync, promises as fs } from 'fs'
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

  test('resolves the default legacy text-backup location', async (t) => {
    const location = await t.context.backups.legacyTextLocation()

    t.truthy(location)
    t.true(path.isAbsolute(location!))
    t.is(path.basename(location!), 'Standard Notes Backups')
  })

  test('saves text backup data and reports the current count', async (t) => {
    const location = path.join(t.context.userDataPath, 'text-backups')
    const data = 'Sample Data'

    await t.context.backups.saveText(location, data)

    t.is(await t.context.backups.textCount(location), 1)
    const files = await fs.readdir(location)
    t.is(files.length, 1)
    t.true(files[0].endsWith('.txt'))
    t.is(await fs.readFile(path.join(location, files[0]), 'utf8'), data)
  })

  test('copies the offline decrypt script into a backup directory', async (t) => {
    const location = path.join(t.context.userDataPath, 'decrypt-script')

    await t.context.backups.copyDecryptScript(location)

    const decryptScript = path.join(location, 'decrypt.html')
    t.true(await fs.stat(decryptScript).then((stat) => stat.isFile()))
    t.true((await fs.readFile(decryptScript, 'utf8')).length > 0)
  })

  test('persists plaintext-note mapping and content together', async (t) => {
    const location = path.join(t.context.userDataPath, 'plaintext-backups')
    const uuid = '00000000-0000-4000-8000-000000000001'
    const data = 'Current plaintext backup'

    await t.context.backups.savePlaintextNote(location, uuid, 'Runtime backup', ['Important'], data)
    await t.context.backups.persistPlaintextMapping(location)

    const mapping = await t.context.backups.plaintextMapping(location)
    const records = mapping.files[uuid]
    t.is(records.length, 1)
    t.is(records[0].tag, 'Important')
    t.is(await fs.readFile(path.join(location, records[0].path), 'utf8'), data)

    const mappingOnDisk = JSON.parse(await fs.readFile(path.join(location, '.settings', 'info.json'), 'utf8'))
    t.deepEqual(mappingOnDisk, mapping)
  })
} else {
  test.skip('backupsManager: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run', () => {})
}
