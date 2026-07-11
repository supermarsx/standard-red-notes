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
