import anyTest, { TestFn } from 'ava'
import { promises as fs } from 'fs'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { FilesManager } from '../app/javascripts/Main/File/FilesManager'
import { createExtensionsServer, normalizeFilePath } from '../app/javascripts/Main/ExtensionsServer'
import { initializeStrings } from '../app/javascripts/Main/Strings'
import makeFakePaths from './fakePaths'
import { createTmpDir } from './testUtils'

const currentFile = fileURLToPath(import.meta.url)
const filesManager = new FilesManager()
const tmpDir = createTmpDir(currentFile)
const FakePaths = makeFakePaths(tmpDir.path)
const extensionsDir = path.join(tmpDir.path, 'Extensions')

const test = anyTest as TestFn<{
  server: http.Server
  host: string
}>

function get(url: string): Promise<{ body: string; etag: string | undefined; statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = ''
        response
          .setEncoding('utf-8')
          .on('data', (chunk) => {
            body += chunk
          })
          .on('end', () => {
            resolve({ body, etag: response.headers.etag, statusCode: response.statusCode })
          })
          .on('error', reject)
      })
      .on('error', reject)
  })
}

initializeStrings('en')

test.before(async (t) => {
  await filesManager.ensureDirectoryExists(extensionsDir)

  let server: http.Server | undefined
  createExtensionsServer({
    paths: FakePaths,
    getVersion: () => 'test-version',
    port: 0,
    createServer(requestListener) {
      server = http.createServer(requestListener)
      return server
    },
  })

  if (!server) {
    throw new Error('Extensions server was not created')
  }

  const startedServer = server
  t.context.server = startedServer
  await new Promise<void>((resolve) => startedServer.once('listening', resolve))
  const { address, port } = startedServer.address() as AddressInfo
  t.context.host = `http://${address}:${port}/`
})

test.after.always(async (t) => {
  await new Promise<void>((resolve, reject) => {
    t.context.server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  await tmpDir.clean()
})

test('serves the files in the Extensions directory over HTTP', async (t) => {
  const data = {
    name: 'Boxes',
    meter: {
      4: 4,
    },
    syncopation: true,
    instruments: ['Drums', 'Bass', 'Vocals', { name: 'Piano', type: 'Electric' }],
  }

  await fs.writeFile(path.join(extensionsDir, 'file.json'), JSON.stringify(data))
  const response = await get(t.context.host + 'Extensions/file.json')

  t.is(response.statusCode, 200)
  t.is(response.etag, 'test-version')
  t.deepEqual(data, JSON.parse(response.body))
})

test('does not serve files outside the Extensions directory', async (t) => {
  const response = await get(t.context.host + 'Extensions/../../../package.json')
  t.is(response.statusCode, 500)
})

test('returns a 404 for files that are not present', async (t) => {
  const response = await get(t.context.host + 'Extensions/nothing')
  t.is(response.statusCode, 404)
})

test('normalizes file paths to always point somewhere in the Extensions directory', (t) => {
  t.is(
    normalizeFilePath('/Extensions/test/yes', '127.0.0.1', FakePaths),
    path.join(tmpDir.path, 'Extensions', 'test', 'yes'),
  )
  t.is(
    normalizeFilePath('/Extensions/../../data/outside/the/extensions/directory', undefined, FakePaths),
    path.join(tmpDir.path, 'Extensions', 'data', 'outside', 'the', 'extensions', 'directory'),
  )
})
