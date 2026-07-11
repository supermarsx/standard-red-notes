import anyTest, { TestFn } from 'ava'
import { existsSync, promises as fs } from 'fs'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { createDriver, Driver } from './driver'
import { createTmpDir } from './testUtils'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const currentFile = fileURLToPath(import.meta.url)
const canRunElectron =
  process.env.RUN_ELECTRON_TESTS === '1' && existsSync(path.join(currentDir, '..', 'app', 'dist', 'index.js'))

const test = anyTest as TestFn<Driver>

if (canRunElectron) {
  const tmpDir = createTmpDir(currentFile)

  const sampleData = {
    title: 'Diamond Dove',
    meter: {
      4: 4,
    },
    instruments: ['Piano', 'Chiptune'],
  }

  let server: http.Server
  let serverAddress: string

  test.before(
    (): Promise<any> =>
      Promise.all([
        tmpDir.make(),
        new Promise((resolve) => {
          server = http.createServer((_req, res) => {
            res.write(JSON.stringify(sampleData))
            res.end()
          })
          server.listen(0, '127.0.0.1', () => {
            const { address, port } = server.address() as AddressInfo
            serverAddress = `http://${address}:${port}`
            resolve(null)
          })
        }),
      ]),
  )

  test.after((): Promise<any> => Promise.all([tmpDir.clean(), new Promise((resolve) => server.close(resolve))]))

  test.beforeEach(async (t) => {
    t.context = await createDriver()
  })
  test.afterEach((t) => t.context.stop())

  test('downloads a JSON file', async (t) => {
    t.deepEqual(await t.context.net.getJSON(serverAddress), sampleData)
  })

  test('downloads a folder to the specified location', async (t) => {
    const filePath = path.join(tmpDir.path, 'fileName.json')
    await t.context.net.downloadFile(serverAddress + '/file', filePath)
    const fileContents = await fs.readFile(filePath, 'utf8')
    t.is(JSON.stringify(sampleData), fileContents)
  })
} else {
  // Spawns a real Electron process against app/dist/index.js; needs a webpack build + display, not runnable headless.
  test.skip(
    'networking: spawns Electron (needs built app/dist/index.js + display); set RUN_ELECTRON_TESTS=1 to run',
    () => {},
  )
}
