import path from 'path'
import { fileURLToPath } from 'url'
import { FilesManager } from '../app/javascripts/Main/File/FilesManager'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const filesManager = new FilesManager()

export function createTmpDir(name: string): {
  path: string
  make(): Promise<string>
  clean(): Promise<void>
} {
  const tmpDirPath = path.join(currentDir, 'data', 'tmp', path.basename(name))

  return {
    path: tmpDirPath,
    async make() {
      await filesManager.ensureDirectoryExists(tmpDirPath)
      return tmpDirPath
    },
    async clean() {
      await filesManager.deleteDir(tmpDirPath)
    },
  }
}
