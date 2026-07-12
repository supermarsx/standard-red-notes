import test from 'ava'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FilesManager } from '../app/javascripts/Main/File/FilesManager'
import { FileErrorCodes } from '../app/javascripts/Main/File/FileErrorCodes'

const currentFile = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFile)

/**
 * The old `Main/Utils/fileUtils` module of free functions was replaced by the
 * `FilesManager` class. These pure-fs tests (no Electron spawn) were rewritten
 * to the instance methods; note the changed return shapes: `deleteDir` and
 * `moveDirContents` now resolve to a `Result` instead of throwing/void, and the
 * `FileDoesNotExist` sentinel is now `FileErrorCodes.FileDoesNotExist`.
 */
const filesManager = new FilesManager()

const dataPath = path.join(currentDir, 'data')
const tmpPath = path.join(dataPath, 'tmp', path.basename(currentFile))
const zipFileDestination = path.join(tmpPath, 'zip-file-output')
const root = path.join(tmpPath, 'tmp1')

test.beforeEach(async () => {
  await filesManager.ensureDirectoryExists(root)
})

test.afterEach(async () => {
  await filesManager.deleteDir(tmpPath)
})

test('extracts a zip, preserving its directory structure', async (t) => {
  await filesManager.extractZip(path.join(dataPath, 'zip-file.zip'), zipFileDestination)
  t.deepEqual(await fs.readdir(zipFileDestination), ['zip-file'])
  t.deepEqual(
    (await fs.readdir(path.join(zipFileDestination, 'zip-file'))).sort(),
    ['package.json', 'test-file.txt'],
  )
})

/**
 * Build a minimal (stored/uncompressed, empty-content) single-entry zip whose
 * file name is a `../` path-traversal. yauzl validates the name while reading the
 * central directory and emits an 'error' event on the zipFile. Before the fix
 * (no `zipFile.on('error')` handler) that unhandled 'error' event would be
 * rethrown by EventEmitter and CRASH the whole main process; the fix routes it
 * through the promise's reject path so extractZip rejects cleanly instead.
 */
function buildTraversalZip(): Buffer {
  const fileName = Buffer.from('../evil.txt')
  const n = fileName.length

  const local = Buffer.alloc(30 + n)
  local.writeUInt32LE(0x04034b50, 0) // local file header signature
  local.writeUInt16LE(20, 4) // version needed to extract
  local.writeUInt16LE(0, 6) // general purpose bit flag
  local.writeUInt16LE(0, 8) // compression method (stored)
  local.writeUInt16LE(0, 10) // last mod time
  local.writeUInt16LE(0, 12) // last mod date
  local.writeUInt32LE(0, 14) // crc-32 (empty content)
  local.writeUInt32LE(0, 18) // compressed size
  local.writeUInt32LE(0, 22) // uncompressed size
  local.writeUInt16LE(n, 26) // file name length
  local.writeUInt16LE(0, 28) // extra field length
  fileName.copy(local, 30)

  const central = Buffer.alloc(46 + n)
  central.writeUInt32LE(0x02014b50, 0) // central directory header signature
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed to extract
  central.writeUInt16LE(0, 8) // general purpose bit flag
  central.writeUInt16LE(0, 10) // compression method
  central.writeUInt16LE(0, 12) // last mod time
  central.writeUInt16LE(0, 14) // last mod date
  central.writeUInt32LE(0, 16) // crc-32
  central.writeUInt32LE(0, 20) // compressed size
  central.writeUInt32LE(0, 24) // uncompressed size
  central.writeUInt16LE(n, 28) // file name length
  central.writeUInt16LE(0, 30) // extra field length
  central.writeUInt16LE(0, 32) // file comment length
  central.writeUInt16LE(0, 34) // disk number start
  central.writeUInt16LE(0, 36) // internal file attributes
  central.writeUInt32LE(0, 38) // external file attributes
  central.writeUInt32LE(0, 42) // relative offset of local header
  fileName.copy(central, 46)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4) // number of this disk
  eocd.writeUInt16LE(0, 6) // disk with start of central directory
  eocd.writeUInt16LE(1, 8) // central directory records on this disk
  eocd.writeUInt16LE(1, 10) // total central directory records
  eocd.writeUInt32LE(central.length, 12) // size of central directory
  eocd.writeUInt32LE(local.length, 16) // offset of central directory
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([local, central, eocd])
}

test('extractZip rejects (does not crash) on a zip with a path-traversal entry', async (t) => {
  const badZipPath = path.join(tmpPath, 'traversal.zip')
  await filesManager.ensureDirectoryExists(path.dirname(badZipPath))
  await fs.writeFile(badZipPath, buildTraversalZip())

  // The whole point of the fix: this must REJECT, not throw an unhandled 'error'
  // event that tears down the process. yauzl's own name validation supplies the
  // rejection message ("invalid relative path: ../evil.txt").
  const error = await t.throwsAsync(() => filesManager.extractZip(badZipPath, zipFileDestination))
  t.regex((error as Error).message, /invalid relative path/)

  // And nothing was written outside (or inside) the destination.
  t.false(await pathExists(path.join(tmpPath, 'evil.txt')))
})

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

test('creates a directory even when parent directories are non-existent', async (t) => {
  await filesManager.ensureDirectoryExists(path.join(root, 'tmp2', 'tmp3'))
  t.deepEqual(await fs.readdir(root), ['tmp2'])
  t.deepEqual(await fs.readdir(path.join(root, 'tmp2')), ['tmp3'])
})

test('deletes a deeply-nesting directory', async (t) => {
  await filesManager.ensureDirectoryExists(path.join(root, 'tmp2', 'tmp3'))
  const result = await filesManager.deleteDir(root)
  t.false(result.isFailed())
  try {
    await fs.readdir(path.join(tmpPath, 'tmp1'))
    t.fail('Should not have been able to read')
  } catch (error: any) {
    if (error.code === FileErrorCodes.FileDoesNotExist) {
      t.pass()
    } else {
      t.fail(error)
    }
  }
})

test('moves the contents of one directory to the other', async (t) => {
  const fileNames = ['1.txt', '2.txt', '3.txt', 'nested/4.txt', 'nested/5.txt', 'nested/6.txt']

  /** Create a temp directory and fill it with files */
  const dir = path.join(tmpPath, 'move_contents_src')
  await filesManager.ensureDirectoryExists(dir)
  await filesManager.ensureDirectoryExists(path.join(dir, 'nested'))
  await Promise.all(fileNames.map((fileName) => fs.writeFile(path.join(dir, fileName), fileName)))

  /** Now move its contents */
  const dest = path.join(tmpPath, 'move_contents_dest')
  const result = await filesManager.moveDirContents(dir, dest)
  t.false(result.isFailed())
  await Promise.all(
    fileNames.map(async (fileName) => {
      const contents = await fs.readFile(path.join(dest, fileName), 'utf8')
      t.is(contents, fileName)
    }),
  )
})

test('moves the contents of one directory to a child directory', async (t) => {
  const srcFileNames = ['1.txt', '2.txt', '3.txt', 'nested/4.txt', 'nested/5.txt', 'nested/6.txt']
  const destFileNames = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt']

  /** Create a temp directory and fill it with files */
  const dir = path.join(tmpPath, 'move_contents_src')
  await filesManager.ensureDirectoryExists(dir)
  await filesManager.ensureDirectoryExists(path.join(dir, 'nested'))
  await Promise.all(srcFileNames.map((fileName) => fs.writeFile(path.join(dir, fileName), fileName)))

  /** Now move its contents */
  const dest = path.join(dir, 'nested')
  const result = await filesManager.moveDirContents(dir, dest)
  t.false(result.isFailed())

  /** Ensure everything is there */
  t.deepEqual((await fs.readdir(dest)).sort(), destFileNames.sort())
  await Promise.all(
    destFileNames.map(async (fileName, index) => {
      const contents = await fs.readFile(path.join(dest, fileName), 'utf8')
      t.is(contents, srcFileNames[index])
    }),
  )
})

test('serializes and deserializes an object to the same values', async (t) => {
  const data = {
    meter: {
      4: 4,
    },
    chorus: {
      passengers: 2,
      destination: 'moon',
      activities: [{ type: 'play', environment: 'stars' }],
    },
  }
  const filePath = path.join(tmpPath, 'data.json')
  await filesManager.writeJSONFile(filePath, data)
  t.deepEqual(data, await filesManager.readJSONFile(filePath))
})
