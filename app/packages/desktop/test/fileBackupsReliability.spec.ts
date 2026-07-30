import test from 'ava'
import { promises as fs } from 'fs'
import http, { IncomingMessage, ServerResponse } from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { writeFileAtomically } from '../app/javascripts/Main/FileBackups/AtomicFileWriter'
import type { AtomicFileWriteOperations } from '../app/javascripts/Main/FileBackups/AtomicFileWriter'
import { FileDownloader } from '../app/javascripts/Main/FileBackups/FileDownloader'
import {
  createPlaintextBackupFileName,
  createPlaintextBackupRelativePath,
  isSafeBackupDirectoryName,
  resolveMappedPlaintextBackupPath,
  resolvePathInsideDirectory,
  sanitizePlaintextBackupPathSegment,
} from '../app/javascripts/Main/FileBackups/PlaintextBackupPaths'

async function createTemporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sn-desktop-backups-'))
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { address, port } = server.address() as AddressInfo
  return { server, url: `http://${address}:${port}` }
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function atomicOperationsWith(overrides: Partial<AtomicFileWriteOperations> = {}): AtomicFileWriteOperations {
  return {
    open: (filePath, flags) => fs.open(filePath, flags),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    rm: (filePath, options) => fs.rm(filePath, options),
    ...overrides,
  }
}

test('atomic writer replaces an existing backup with one complete sibling-temp publish', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'note.txt')

  try {
    await fs.writeFile(destination, 'previous backup')
    await writeFileAtomically(destination, 'complete replacement')

    t.is(await fs.readFile(destination, 'utf8'), 'complete replacement')
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('atomic writer preserves the previous file after a partial temporary write', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'info.json')
  const previous = '{"version":"known-good"}'

  try {
    await fs.writeFile(destination, previous)

    await t.throwsAsync(
      writeFileAtomically(
        destination,
        '{"version":"replacement"}',
        atomicOperationsWith({
          open: async (filePath, flags) => {
            const handle = await fs.open(filePath, flags)
            return {
              writeFile: async (data, encoding) => {
                await handle.writeFile(data.slice(0, 5), encoding)
                throw new Error('simulated disk-full write')
              },
              sync: () => handle.sync(),
              close: () => handle.close(),
            }
          },
        }),
      ),
      { message: 'simulated disk-full write' },
    )

    t.is(await fs.readFile(destination, 'utf8'), previous)
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('atomic writer preserves the previous file and removes its temporary output when publish fails', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'note.txt')
  const previous = 'known-good note backup'

  try {
    await fs.writeFile(destination, previous)

    await t.throwsAsync(
      writeFileAtomically(
        destination,
        'replacement note backup',
        atomicOperationsWith({
          rename: async () => {
            throw new Error('simulated rename failure')
          },
        }),
      ),
      { message: 'simulated rename failure' },
    )

    t.is(await fs.readFile(destination, 'utf8'), previous)
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('encrypted file backup replaces stale bytes and validates every downloaded range', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'file.encrypted')
  const expected = Buffer.from('abcdefghij')
  const requestedStarts: number[] = []

  const { server, url } = await startServer((request, response) => {
    const range = /^bytes=(\d+)-$/.exec(String(request.headers.range))
    const requestedSize = Number(request.headers['x-chunk-size'])
    if (!range || !Number.isSafeInteger(requestedSize)) {
      response.writeHead(400).end()
      return
    }

    const start = Number(range[1])
    const end = Math.min(start + requestedSize - 1, expected.length - 1)
    requestedStarts.push(start)
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${expected.length}`,
    })
    response.end(expected.subarray(start, end + 1))
  })

  try {
    await fs.writeFile(destination, 'stale bytes that must not be appended')

    const result = await new FileDownloader([4, 4, 4], 'token', url, destination).run()

    t.is(result, 'success')
    t.deepEqual(await fs.readFile(destination), expected)
    t.deepEqual(requestedStarts, [0, 4, 8])
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await stopServer(server)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('failed encrypted file retry preserves the last complete file and removes its temporary output', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'file.encrypted')
  const existing = Buffer.from('known-good-backup')
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(206, {
      /** The requested range starts at zero, so this response must be rejected. */
      'content-range': 'bytes 1-3/4',
    })
    response.end('bad')
  })

  try {
    await fs.writeFile(destination, existing)

    const result = await new FileDownloader([3], 'token', url, destination).run()

    t.is(result, 'failed')
    t.deepEqual(await fs.readFile(destination), existing)
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await stopServer(server)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('encrypted file backup rejects a full response to a range request', async (t) => {
  const directory = await createTemporaryDirectory()
  const destination = path.join(directory, 'file.encrypted')
  const existing = Buffer.from('known-good-backup')
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, {
      'content-range': 'bytes 0-3/4',
    })
    response.end('data')
  })

  try {
    await fs.writeFile(destination, existing)

    const result = await new FileDownloader([4], 'token', url, destination).run()

    t.is(result, 'failed')
    t.deepEqual(await fs.readFile(destination), existing)
    t.deepEqual(
      (await fs.readdir(directory)).filter((fileName) => fileName.endsWith('.partial')),
      [],
    )
  } finally {
    await stopServer(server)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('plaintext backup paths sanitize hostile title/tag segments and reject mapped traversal', (t) => {
  const location = path.resolve('Plaintext Backups')
  const safeTitle = sanitizePlaintextBackupPathSegment('../unsafe:name.', 'Untitled')
  const safeTag = sanitizePlaintextBackupPathSegment('../../escaped-tag', 'Untagged')
  const reservedTag = sanitizePlaintextBackupPathSegment('CON', 'Untagged')
  const filename = createPlaintextBackupFileName('../unsafe:name.', '12345678-1234-1234-1234-123456789abc')
  const relativeBackupPath = createPlaintextBackupRelativePath(filename, '../../escaped-tag')
  const absolutePath = resolvePathInsideDirectory(location, relativeBackupPath)
  const relativePath = path.relative(location, absolutePath)

  t.false(relativePath.startsWith('..'))
  t.false(path.isAbsolute(relativePath))
  t.false(safeTag.includes('/') || safeTag.includes('\\'))
  t.true(filename.startsWith(safeTitle))
  t.true(filename.includes('12345678123412341234123456789abc'))
  t.not(filename, createPlaintextBackupFileName('../unsafe:name.', '12345678-1234-1234-1234-123456789abd'))
  t.true(createPlaintextBackupFileName('🙂'.repeat(200), 'x'.repeat(200)).length <= 230)
  t.is(reservedTag, '_CON')
  t.true(filename.endsWith('.txt'))

  t.is(resolveMappedPlaintextBackupPath(location, path.join('..', 'outside.txt')), undefined)
  t.is(resolveMappedPlaintextBackupPath(location, path.join('.settings', 'info.txt')), undefined)
  t.throws(() => resolvePathInsideDirectory(location, '..', 'outside.txt'))
  t.true(isSafeBackupDirectoryName('12345678-1234-1234-1234-123456789abc'))
  t.false(isSafeBackupDirectoryName('../outside'))
  t.false(isSafeBackupDirectoryName('CON'))
  t.false(isSafeBackupDirectoryName('__proto__'))
})
