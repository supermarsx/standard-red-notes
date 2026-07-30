import { LoggingDomain, log } from './../../../Logging'
import {
  FileBackupsDevice,
  FileBackupsMapping,
  FileBackupReadToken,
  FileBackupReadChunkResponse,
  PlaintextBackupsMapping,
  DesktopWatchedDirectoriesChange,
} from '@web/Application/Device/DesktopSnjsExports'
import { AppState } from 'app/AppState'
import { promises as fs, existsSync } from 'fs'
import { WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { StoreKeys } from '../Store/StoreKeys'
import path from 'path'
import { FileDownloader } from './FileDownloader'
import { FileReadOperation } from './FileReadOperation'
import { Paths } from '../Types/Paths'
import { MessageToWebApp } from '../../Shared/IpcMessages'
import { FilesManagerInterface } from '../File/FilesManagerInterface'
import {
  createPlaintextBackupFileName,
  createPlaintextBackupRelativePath,
  isSafeBackupDirectoryName,
  resolveMappedPlaintextBackupPath,
  resolvePathInsideDirectory,
} from './PlaintextBackupPaths'
import { writeFileAtomically } from './AtomicFileWriter'

const TextBackupFileExtension = '.txt'

const formatPlaintextBackupTimestamp = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  )
}

export const FileBackupsConstantsV1 = {
  Version: '1.0.0',
  MetadataFileName: 'metadata.sn.json',
  BinaryFileName: 'file.encrypted',
}

export class FilesBackupManager implements FileBackupsDevice {
  private readOperations: Map<string, FileReadOperation> = new Map()
  private plaintextMappingCache = new Map<string, PlaintextBackupsMapping>()
  private plaintextPendingDeletions = new Map<string, Set<string>>()

  constructor(
    private appState: AppState,
    private webContents: WebContents,
    private filesManager: FilesManagerInterface,
  ) {}

  private async findUuidForPlaintextBackupFileName(
    backupsDirectory: string,
    targetFilename: string,
  ): Promise<string | undefined> {
    const mapping = await this.getPlaintextBackupsMappingFile(backupsDirectory)

    const uuid = Object.keys(mapping.files).find((uuid) => {
      const entries = mapping.files[uuid]
      for (const entry of entries) {
        const filePath = entry.path
        const filename = path.basename(filePath)
        if (filename === targetFilename) {
          return true
        }
      }
      return false
    })

    return uuid
  }

  async joinPaths(...paths: string[]): Promise<string> {
    return path.join(...paths)
  }

  public async migrateLegacyFileBackupsToNewStructure(newLocation: string): Promise<void> {
    const legacyLocation = await this.getLegacyFilesBackupsLocation()
    if (!legacyLocation) {
      return
    }

    await this.filesManager.ensureDirectoryExists(newLocation)

    const legacyMappingLocation = path.join(legacyLocation, 'info.json')
    const newMappingLocation = this.getFileBackupsMappingFilePath(newLocation)
    await this.filesManager.ensureDirectoryExists(path.dirname(newMappingLocation))
    if (existsSync(legacyMappingLocation)) {
      await this.filesManager.moveFile(legacyMappingLocation, newMappingLocation)
    }

    await this.filesManager.moveDirContents(legacyLocation, newLocation)
  }

  public async isLegacyFilesBackupsEnabled(): Promise<boolean> {
    return this.appState.store.get(StoreKeys.LegacyFileBackupsEnabled)
  }

  async wasLegacyTextBackupsExplicitlyDisabled(): Promise<boolean> {
    const value = this.appState.store.get(StoreKeys.LegacyTextBackupsDisabled)
    return value === true
  }

  async getUserDocumentsDirectory(): Promise<string | undefined> {
    return Paths.documentsDir
  }

  public async getLegacyFilesBackupsLocation(): Promise<string | undefined> {
    return this.appState.store.get(StoreKeys.LegacyFileBackupsLocation)
  }

  async getLegacyTextBackupsLocation(): Promise<string | undefined> {
    const savedLocation = this.appState.store.get(StoreKeys.LegacyTextBackupsLocation)
    if (savedLocation) {
      return savedLocation
    }

    const LegacyTextBackupsDirectory = 'Standard Notes Backups'
    const homeDir = Paths.homeDir
    if (homeDir) {
      return path.join(homeDir, LegacyTextBackupsDirectory)
    }

    return undefined
  }

  private getFileBackupsMappingFilePath(backupsLocation: string): string {
    return path.join(backupsLocation, '.settings', 'info.json')
  }

  private async getFileBackupsMappingFileFromDisk(backupsLocation: string): Promise<FileBackupsMapping | undefined> {
    return this.filesManager.readJSONFile<FileBackupsMapping>(this.getFileBackupsMappingFilePath(backupsLocation))
  }

  private defaulFileBackupstMappingFileValue(): FileBackupsMapping {
    return { version: FileBackupsConstantsV1.Version, files: {} }
  }

  async getFilesBackupsMappingFile(backupsLocation: string): Promise<FileBackupsMapping> {
    const data = await this.getFileBackupsMappingFileFromDisk(backupsLocation)

    if (!data) {
      return this.defaulFileBackupstMappingFileValue()
    }

    for (const entry of Object.values(data.files)) {
      entry.backedUpOn = new Date(entry.backedUpOn)
    }

    return data
  }

  private async saveFilesBackupsMappingFile(location: string, file: FileBackupsMapping): Promise<'success' | 'failed'> {
    const mappingPath = this.getFileBackupsMappingFilePath(location)
    await this.filesManager.ensureDirectoryExists(path.dirname(mappingPath))
    await writeFileAtomically(mappingPath, JSON.stringify(file, null, 2))

    return 'success'
  }

  async saveFilesBackupsFile(
    location: string,
    uuid: string,
    metaFile: string,
    downloadRequest: {
      chunkSizes: number[]
      valetToken: string
      url: string
    },
  ): Promise<'success' | 'failed'> {
    if (!isSafeBackupDirectoryName(uuid)) {
      console.error('Refusing to save an encrypted file backup with an unsafe identifier')
      return 'failed'
    }

    const fileDir = resolvePathInsideDirectory(location, uuid)
    const operationId = `${process.pid}-${randomUUID()}`
    const stagingDir = resolvePathInsideDirectory(location, `${uuid}.partial-${operationId}`)
    const previousDir = resolvePathInsideDirectory(location, `${uuid}.previous-${operationId}`)
    let previousDirectoryMoved = false
    let replacementPublished = false

    try {
      await this.filesManager.ensureDirectoryExists(stagingDir)
      await this.filesManager.writeFile(path.join(stagingDir, FileBackupsConstantsV1.MetadataFileName), metaFile)

      const downloader = new FileDownloader(
        downloadRequest.chunkSizes,
        downloadRequest.valetToken,
        downloadRequest.url,
        path.join(stagingDir, FileBackupsConstantsV1.BinaryFileName),
      )

      const result = await downloader.run()
      if (result !== 'success') {
        return result
      }

      /**
       * Metadata and ciphertext are one logical backup. Swap the completed
       * staging directory into place as a unit so a retry can never pair a new
       * metadata file with stale/partial ciphertext (or vice versa).
       */
      if (existsSync(fileDir)) {
        await fs.rename(fileDir, previousDir)
        previousDirectoryMoved = true
      }

      try {
        await fs.rename(stagingDir, fileDir)
        replacementPublished = true
      } catch (error) {
        if (previousDirectoryMoved) {
          await fs.rename(previousDir, fileDir)
          previousDirectoryMoved = false
        }
        throw error
      }

      const mapping = await this.getFilesBackupsMappingFile(location)

      mapping.files[uuid] = {
        backedUpOn: new Date(),
        relativePath: uuid,
        metadataFileName: FileBackupsConstantsV1.MetadataFileName,
        binaryFileName: FileBackupsConstantsV1.BinaryFileName,
        version: FileBackupsConstantsV1.Version,
      }

      await this.saveFilesBackupsMappingFile(location, mapping)
      return 'success'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed to save encrypted file backup', message)
      return 'failed'
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)

      if (replacementPublished) {
        await fs.rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
      } else if (previousDirectoryMoved && !existsSync(fileDir)) {
        await fs.rename(previousDir, fileDir).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error('Failed to restore previous encrypted file backup', message)
        })
      }
    }
  }

  async getFileBackupReadToken(filePath: string): Promise<FileBackupReadToken> {
    const operation = new FileReadOperation(filePath)

    this.readOperations.set(operation.token, operation)

    return operation.token
  }

  async readNextChunk(token: string): Promise<FileBackupReadChunkResponse> {
    const operation = this.readOperations.get(token)

    if (!operation) {
      return Promise.reject(new Error('Invalid token'))
    }

    const result = await operation.readNextChunk()

    if (result.isLast) {
      this.readOperations.delete(token)
    }

    return result
  }

  async getTextBackupsCount(location: string): Promise<number> {
    let files = await fs.readdir(location)
    files = files.filter((fileName) => fileName.endsWith(TextBackupFileExtension))
    return files.length
  }

  async saveTextBackupData(location: string, data: string): Promise<void> {
    log(LoggingDomain.Backups, 'Saving text backup data', 'to', location)
    let success: boolean

    try {
      await this.filesManager.ensureDirectoryExists(location)
      const name = `${new Date().toISOString().replace(/:/g, '-')}${TextBackupFileExtension}`
      const filePath = path.join(location, name)
      await fs.writeFile(filePath, data)
      success = true
    } catch (err) {
      success = false
      console.error('An error occurred saving backup file', err)
    }

    log(LoggingDomain.Backups, 'Finished saving text backup data', { success })
  }

  async copyDecryptScript(location: string) {
    try {
      await this.filesManager.ensureDirectoryExists(location)
      await fs.copyFile(Paths.decryptScript, path.join(location, path.basename(Paths.decryptScript)))
    } catch (error) {
      console.error(error)
    }
  }

  private getPlaintextMappingFilePath(location: string): string {
    return path.join(location, '.settings', 'info.json')
  }

  private async getPlaintextMappingFileFromDisk(location: string): Promise<PlaintextBackupsMapping | undefined> {
    return this.filesManager.readJSONFile<PlaintextBackupsMapping>(this.getPlaintextMappingFilePath(location))
  }

  private async savePlaintextBackupsMappingFile(
    location: string,
    file: PlaintextBackupsMapping,
  ): Promise<'success' | 'failed'> {
    const mappingPath = this.getPlaintextMappingFilePath(location)
    await this.filesManager.ensureDirectoryExists(path.dirname(mappingPath))
    await writeFileAtomically(mappingPath, JSON.stringify(file, null, 2))

    return 'success'
  }

  private defaultPlaintextMappingFileValue(): PlaintextBackupsMapping {
    return { version: '1.0', files: {} }
  }

  async getPlaintextBackupsMappingFile(location: string): Promise<PlaintextBackupsMapping> {
    const cacheKey = path.resolve(location)
    const cachedMapping = this.plaintextMappingCache.get(cacheKey)
    if (cachedMapping) {
      return cachedMapping
    }

    let data = await this.getPlaintextMappingFileFromDisk(location)

    if (!data || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
      data = this.defaultPlaintextMappingFileValue()
    }

    this.plaintextMappingCache.set(cacheKey, data)

    return data
  }

  async savePlaintextNoteBackup(
    location: string,
    uuid: string,
    name: string,
    tags: string[],
    data: string,
  ): Promise<void> {
    log(LoggingDomain.Backups, 'Saving plaintext note backup', uuid, 'to', location)

    if (!isSafeBackupDirectoryName(uuid)) {
      throw new Error('Refusing to save a plaintext backup with an unsafe identifier')
    }

    const mapping = await this.getPlaintextBackupsMappingFile(location)
    const mappedRecords = mapping.files[uuid]
    const previousRecords = Array.isArray(mappedRecords) ? mappedRecords : []
    const newRecords: PlaintextBackupsMapping['files'][string] = []

    const writeFileToPath = async (filename: string, data: string, forTag?: string) => {
      const relativePath = createPlaintextBackupRelativePath(filename, forTag)
      const fileAbsolutePath = resolvePathInsideDirectory(location, relativePath)

      await this.filesManager.ensureDirectoryExists(path.dirname(fileAbsolutePath))
      await writeFileAtomically(fileAbsolutePath, data)

      newRecords.push({
        tag: forTag,
        path: relativePath,
      })
    }

    const trimmedName = name.trim()
    const baseName = trimmedName.length > 0 ? trimmedName : formatPlaintextBackupTimestamp(new Date())
    const backupFilename = createPlaintextBackupFileName(baseName, uuid)

    if (tags.length === 0) {
      await writeFileToPath(backupFilename, data)
    } else {
      for (const tag of tags) {
        await writeFileToPath(backupFilename, data, tag)
      }
    }

    /**
     * Only retire the previous copies after every replacement has been
     * written. A disk error while writing a new backup therefore leaves the
     * last known-good copies and mapping intact.
     */
    const pathKey = (filePath: string) => {
      const normalized = path.normalize(filePath)
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    const cacheKey = path.resolve(location)
    const pendingDeletions = this.plaintextPendingDeletions.get(cacheKey) ?? new Set<string>()
    const newPaths = new Set(newRecords.map((record) => pathKey(record.path)))
    for (const record of newRecords) {
      pendingDeletions.delete(pathKey(resolvePathInsideDirectory(location, record.path)))
    }
    const pathsReferencedByOtherNotes = new Set<string>()
    for (const [recordUuid, records] of Object.entries(mapping.files)) {
      if (recordUuid === uuid || !Array.isArray(records)) {
        continue
      }
      for (const record of records) {
        if (record && typeof record.path === 'string') {
          pathsReferencedByOtherNotes.add(pathKey(record.path))
        }
      }
    }

    for (const record of previousRecords) {
      if (!record || typeof record.path !== 'string') {
        console.error('Ignoring invalid record in plaintext backups mapping')
        continue
      }
      const previousPathKey = pathKey(record.path)
      if (newPaths.has(previousPathKey) || pathsReferencedByOtherNotes.has(previousPathKey)) {
        continue
      }

      const filePath = resolveMappedPlaintextBackupPath(location, record.path)
      if (!filePath) {
        console.error('Ignoring unsafe path in plaintext backups mapping')
        continue
      }

      pendingDeletions.add(pathKey(filePath))
    }

    mapping.files[uuid] = newRecords
    this.plaintextPendingDeletions.set(cacheKey, pendingDeletions)
  }

  async persistPlaintextBackupsMappingFile(location: string): Promise<void> {
    const cacheKey = path.resolve(location)
    const mapping = this.plaintextMappingCache.get(cacheKey)
    if (!mapping) {
      return
    }

    await this.savePlaintextBackupsMappingFile(location, mapping)

    /**
     * Persist the replacement mapping before deleting superseded files. If the
     * mapping write fails or the app exits mid-save, the last known-good files
     * remain recoverable; a crash after persistence can leave only harmless
     * stale copies.
     */
    const pendingDeletions = this.plaintextPendingDeletions.get(cacheKey)
    if (!pendingDeletions) {
      return
    }

    const referencedPaths = new Set<string>()
    for (const records of Object.values(mapping.files)) {
      if (!Array.isArray(records)) {
        continue
      }
      for (const record of records) {
        if (!record || typeof record.path !== 'string') {
          continue
        }
        const filePath = resolveMappedPlaintextBackupPath(location, record.path)
        if (filePath) {
          referencedPaths.add(process.platform === 'win32' ? filePath.toLowerCase() : filePath)
        }
      }
    }

    for (const filePath of pendingDeletions) {
      if (!referencedPaths.has(filePath)) {
        await this.filesManager.deleteFileIfExists(filePath)
      }
    }
    this.plaintextPendingDeletions.delete(cacheKey)
  }

  async monitorPlaintextBackupsLocationForChanges(backupsDirectory: string): Promise<void> {
    const FEATURE_ENABLED = false
    if (!FEATURE_ENABLED) {
      return
    }

    try {
      const watcher = fs.watch(backupsDirectory, { recursive: true })
      for await (const event of watcher) {
        const { eventType, filename } = event
        if (!filename) {
          continue
        }

        if (eventType !== 'change' && eventType !== 'rename') {
          continue
        }
        const itemUuid = await this.findUuidForPlaintextBackupFileName(backupsDirectory, filename)
        if (itemUuid) {
          try {
            const change: DesktopWatchedDirectoriesChange = {
              itemUuid,
              path: path.join(backupsDirectory, filename),
              type: eventType,
              content: await fs.readFile(path.join(backupsDirectory, filename), 'utf-8'),
            }
            this.webContents.send(MessageToWebApp.WatchedDirectoriesChanges, [change])
          } catch (err) {
            log(LoggingDomain.Backups, 'Error processing watched change', err)
            continue
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return
      }
      throw err
    }
  }
}
