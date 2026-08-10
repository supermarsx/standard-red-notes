import test from 'ava'
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { getLoopbackHomeServerUrl, HOME_SERVER_HOST } from '../app/javascripts/Main/HomeServer/HomeServerNetwork.js'

const require = createRequire(import.meta.url)
const currentDir = path.dirname(fileURLToPath(import.meta.url))

test('advertises the embedded home server only on the IPv4 loopback address', (t) => {
  t.is(HOME_SERVER_HOST, '127.0.0.1')
  t.is(getLoopbackHomeServerUrl(3127), 'http://127.0.0.1:3127')
})

test('the installed home-server runtime binds its listener to IPv4 loopback', async (t) => {
  const packageManifestPath = require.resolve('@standardnotes/home-server/package.json', {
    paths: [path.join(currentDir, '..', 'app')],
  })
  const runtimePath = path.join(path.dirname(packageManifestPath), 'dist', 'src', 'Server', 'HomeServer.js')
  const runtime = await fs.readFile(runtimePath, 'utf8')

  t.regex(runtime, /server\.build\(\)\.listen\(port, ['"]127\.0\.0\.1['"]\)/)
  t.notRegex(runtime, /server\.build\(\)\.listen\(port\)/)
})
