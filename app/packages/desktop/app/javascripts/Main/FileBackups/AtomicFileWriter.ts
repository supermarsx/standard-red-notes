import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'

export interface AtomicFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface AtomicFileWriteOperations {
  open(filePath: string, flags: 'wx'): Promise<AtomicFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  rm(filePath: string, options: { force: true }): Promise<void>
}

const nodeFileWriteOperations: AtomicFileWriteOperations = {
  open: (filePath, flags) => fs.open(filePath, flags),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options),
}

/**
 * Replaces a file only after its complete contents have reached a sibling
 * temporary file. A failed write or publish leaves the previous destination
 * untouched and the temporary output is always removed.
 */
export async function writeFileAtomically(
  destinationPath: string,
  data: string,
  operations: AtomicFileWriteOperations = nodeFileWriteOperations,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.partial`
  let fileHandle: AtomicFileHandle | undefined

  try {
    fileHandle = await operations.open(temporaryPath, 'wx')
    await fileHandle.writeFile(data, 'utf8')
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = undefined

    await operations.rename(temporaryPath, destinationPath)
  } finally {
    await fileHandle?.close().catch(() => undefined)
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
