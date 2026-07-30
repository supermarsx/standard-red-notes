import { KeyParamsData } from '@standardnotes/responses'
import { MapperInterface, Result } from '@standardnotes/domain-core'
import { promises } from 'fs'
import { FileHandle } from 'fs/promises'
import * as uuid from 'uuid'
import { Logger } from 'winston'
import { dirname, isAbsolute, relative, resolve } from 'path'

import { Item } from '../../Domain/Item/Item'
import { ItemBackupServiceInterface } from '../../Domain/Item/ItemBackupServiceInterface'
import { ItemBackupRepresentation } from '../../Mapping/Backup/ItemBackupRepresentation'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'

export interface FSItemBackupOperations {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  open(path: string, flags: 'wx', mode: number): Promise<FileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

const nodeFileOperations: FSItemBackupOperations = {
  mkdir: (path, options) => promises.mkdir(path, options),
  chmod: (path, mode) => promises.chmod(path, mode),
  open: (path, flags, mode) => promises.open(path, flags, mode),
  rename: (oldPath, newPath) => promises.rename(oldPath, newPath),
  rm: (path, options) => promises.rm(path, options),
}

export class FSItemBackupService implements ItemBackupServiceInterface {
  constructor(
    private fileUploadPath: string,
    private backupMapper: MapperInterface<Item, ItemBackupRepresentation>,
    private httpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    private logger: Logger,
    private generateUuid: () => string = uuid.v4,
    private fileOperations: FSItemBackupOperations = nodeFileOperations,
  ) {}

  async backup(items: Item[], authParams: KeyParamsData, contentSizeLimit?: number): Promise<string[]> {
    if (items.length === 0) {
      return []
    }

    if (contentSizeLimit !== undefined && (!Number.isSafeInteger(contentSizeLimit) || contentSizeLimit <= 0)) {
      throw new Error('Backup content size limit must be a positive integer')
    }

    const backupFileNames: string[] = []
    let bundle: ItemHttpRepresentation[] = []

    for (const item of items) {
      const projection = this.httpMapper.toProjection(item)
      const candidateBundle = [...bundle, projection]

      if (
        contentSizeLimit !== undefined &&
        bundle.length > 0 &&
        this.backupContentsByteLength(candidateBundle, authParams) > contentSizeLimit
      ) {
        backupFileNames.push(await this.createBackupFile(bundle, authParams))
        bundle = [projection]
      } else {
        bundle = candidateBundle
      }
    }

    if (bundle.length > 0) {
      backupFileNames.push(await this.createBackupFile(bundle, authParams))
    }

    return backupFileNames
  }

  async dump(item: Item): Promise<Result<string>> {
    try {
      const contents = JSON.stringify({
        item: this.backupMapper.toProjection(item),
      })

      const path = `${this.fileUploadPath}/dumps/${uuid.v4()}`

      this.logger.debug(`Dumping item ${item.id.toString()} to ${path}`)

      await promises.mkdir(dirname(path), { recursive: true })

      await promises.writeFile(path, contents)

      const fileCreated = (await promises.stat(path)).isFile()

      if (!fileCreated) {
        return Result.fail(`Could not create dump file ${path}`)
      }

      return Result.ok(path)
    } catch (error) {
      return Result.fail(`Could not dump item: ${(error as Error).message}`)
    }
  }

  private backupContents(itemRepresentations: ItemHttpRepresentation[], authParams: KeyParamsData): string {
    return JSON.stringify({
      items: itemRepresentations,
      auth_params: authParams,
    })
  }

  private backupContentsByteLength(itemRepresentations: ItemHttpRepresentation[], authParams: KeyParamsData): number {
    return Buffer.byteLength(this.backupContents(itemRepresentations, authParams), 'utf8')
  }

  private async createBackupFile(
    itemRepresentations: ItemHttpRepresentation[],
    authParams: KeyParamsData,
  ): Promise<string> {
    if (itemRepresentations.length === 0) {
      throw new Error('Refusing to create an empty backup file')
    }

    const backupDirectory = this.backupDirectory()
    const fileName = `${this.generateUuid()}.json`
    const destinationPath = this.resolvePathInsideDirectory(backupDirectory, fileName)
    const temporaryPath = this.resolvePathInsideDirectory(
      backupDirectory,
      `.${fileName}.${this.generateUuid()}.partial`,
    )
    const contents = this.backupContents(itemRepresentations, authParams)
    let fileHandle: FileHandle | undefined

    try {
      await this.fileOperations.mkdir(backupDirectory, { recursive: true, mode: 0o700 })
      await this.fileOperations.chmod(backupDirectory, 0o700)

      fileHandle = await this.fileOperations.open(temporaryPath, 'wx', 0o600)
      await fileHandle.writeFile(contents, 'utf8')
      await fileHandle.sync()
      await fileHandle.close()
      fileHandle = undefined

      await this.fileOperations.rename(temporaryPath, destinationPath)

      this.logger.debug(`Created item backup ${destinationPath}`)

      return fileName
    } finally {
      await fileHandle?.close().catch(() => undefined)
      await this.fileOperations.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private backupDirectory(): string {
    if (typeof this.fileUploadPath !== 'string' || !this.fileUploadPath.trim()) {
      throw new Error('File upload path is not configured')
    }

    return resolve(this.fileUploadPath.trim(), 'backups')
  }

  private resolvePathInsideDirectory(directory: string, fileName: string): string {
    const candidate = resolve(directory, fileName)
    const relativePath = relative(directory, candidate)

    if (!relativePath || dirname(relativePath) !== '.' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Invalid backup path ${fileName}`)
    }

    return candidate
  }
}
