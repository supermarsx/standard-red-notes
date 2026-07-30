/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { ChildProcess, spawn } from 'child_process'
import electronPath from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { Language } from '../app/javascripts/Main/SpellcheckerManager'
import { StoreKeys } from '../app/javascripts/Main/Store/StoreKeys'
import { UpdateState } from '../app/javascripts/Main/UpdateManager'
import { FilesManager } from '../app/javascripts/Main/File/FilesManager'
import { CommandLineArgs } from '../app/javascripts/Shared/CommandLineArgs'
import {
  AppMessageType,
  AppTestMessage,
  MessageType,
  TestIPCMessage,
  TestIPCMessageResult,
  TestMenuItemSnapshot,
} from './TestIpcMessage'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const filesManager = new FilesManager()

function spawnAppprocess(userDataPath: string) {
  const p = spawn(
    electronPath as any,
    [path.join(currentDir, '..'), CommandLineArgs.Testing, CommandLineArgs.UserDataPath, userDataPath],
    {
      env: {
        ...process.env,
        STANDARD_NOTES_TEST_MODE: '1',
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    },
  )
  return p
}

class Driver {
  private appProcess: ChildProcess

  private calls: Array<{
    resolve: (...args: any) => void
    reject: (...args: any) => void
  } | null> = []

  private awaitedOnMessages: Array<{
    type: AppMessageType
    resolve: (...args: any) => void
  }> = []

  appReady: Promise<unknown>
  windowLoaded: Promise<unknown>

  constructor(readonly userDataPath: string) {
    this.appProcess = spawnAppprocess(userDataPath)
    this.appProcess.on('message', this.receive)
    this.appReady = this.waitOn(AppMessageType.Ready)
    this.windowLoaded = this.waitOn(AppMessageType.WindowLoaded)
  }

  private receive = (message: TestIPCMessageResult | AppTestMessage) => {
    if ('type' in message) {
      if (message.type === AppMessageType.Log) {
        console.log(message)
      }

      this.awaitedOnMessages = this.awaitedOnMessages.filter(({ type, resolve }) => {
        if (type === message.type) {
          resolve()
          return false
        }
        return true
      })
    }

    if ('id' in message) {
      const call = this.calls[message.id]!
      this.calls[message.id] = null
      if (message.reject) {
        call.reject(message.reject)
      } else {
        call.resolve(message.resolve)
      }
    }
  }

  private waitOn = (messageType: AppMessageType) => {
    return new Promise((resolve) => {
      this.awaitedOnMessages.push({
        type: messageType,
        resolve,
      })
    })
  }

  private send = (type: MessageType, ...args: any): Promise<any> => {
    const id = this.calls.length
    const message: TestIPCMessage = {
      id,
      type,
      args,
    }

    this.appProcess.send(message)

    return new Promise((resolve, reject) => {
      this.calls.push({ resolve, reject })
    })
  }

  windowCount = (): Promise<number> => this.send(MessageType.WindowCount)

  appStateCall = (methodName: string, ...args: any): Promise<any> =>
    this.send(MessageType.AppStateCall, methodName, ...args)

  readonly window = {
    clearRendererStorage: (): Promise<void> => this.send(MessageType.ClearRendererStorage),
  }

  readonly storage = {
    dataOnDisk: async (): Promise<{ [key in StoreKeys]: any }> => {
      const location = await this.send(MessageType.StoreSettingsLocation)
      return filesManager.readJSONFile(location) as Promise<{ [key in StoreKeys]: any }>
    },
    dataLocation: (): Promise<string> => this.send(MessageType.StoreSettingsLocation),
    setZoomFactor: (factor: number) => this.send(MessageType.StoreSet, 'zoomFactor', factor),
    setLocalStorageValue: (key: string, value: string): Promise<void> =>
      this.send(MessageType.SetLocalStorageValue, key, value),
    getLocalStorageValue: (key: string): Promise<string | null> => this.send(MessageType.GetRendererStorageValue, key),
  }

  readonly appMenu = {
    items: (): Promise<TestMenuItemSnapshot[]> => this.send(MessageType.AppMenuItems),
    clickLanguage: (language: Language) => this.send(MessageType.ClickLanguage, language),
    hasReloaded: () => this.send(MessageType.HasReloadedMenu),
  }

  readonly spellchecker = {
    manager: () => this.send(MessageType.SpellCheckerManager),
    languages: () => this.send(MessageType.SpellCheckerLanguages),
  }

  readonly backups = {
    legacyTextLocation: (): Promise<string | undefined> => this.send(MessageType.GetLegacyTextBackupsLocation),
    copyDecryptScript: async (location: string) => {
      await this.send(MessageType.CopyDecryptScript, location)
    },
    saveText: (location: string, data: string): Promise<void> =>
      this.send(MessageType.SaveTextBackupData, location, data),
    textCount: (location: string): Promise<number> => this.send(MessageType.GetTextBackupsCount, location),
    savePlaintextNote: (location: string, uuid: string, name: string, tags: string[], data: string): Promise<void> =>
      this.send(MessageType.SavePlaintextNoteBackup, location, uuid, name, tags, data),
    persistPlaintextMapping: (location: string): Promise<void> =>
      this.send(MessageType.PersistPlaintextBackupsMapping, location),
    plaintextMapping: (location: string): Promise<{ files: Record<string, Array<{ path: string; tag?: string }>> }> =>
      this.send(MessageType.GetPlaintextBackupsMapping, location),
  }

  readonly updates = {
    state: (): Promise<UpdateState> => this.send(MessageType.UpdateState),
    autoUpdateEnabled: (): Promise<boolean> => this.send(MessageType.AutoUpdateEnabled),
    check: () => this.send(MessageType.CheckForUpdate),
  }

  readonly net = {
    getJSON: (url: string) => this.send(MessageType.GetJSON, url),
    downloadFile: (url: string, filePath: string) => this.send(MessageType.DownloadFile, url, filePath),
  }

  stop = async () => {
    this.appProcess.kill()

    /** Give the process a little time before cleaning up */
    await new Promise((resolve) => setTimeout(resolve, 150))

    /**
     * Windows can hit EPERM or EBUSY when we try to delete the user data
     * directory too quickly. FilesManager.deleteDir swallows the error and
     * returns a failed Result instead of throwing, so retry on isFailed().
     */
    const maxTries = 5
    let lastError = ''
    for (let i = 0; i < maxTries; i++) {
      const result = await filesManager.deleteDir(this.userDataPath)
      if (!result.isFailed()) {
        return
      }
      lastError = result.getError()
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(`Couldn't delete user data directory after ${maxTries} tries: ${lastError}`)
  }

  restart = async () => {
    this.appProcess.kill()
    this.appProcess = spawnAppprocess(this.userDataPath)
    this.appProcess.on('message', this.receive)
    this.appReady = this.waitOn(AppMessageType.Ready)
    this.windowLoaded = this.waitOn(AppMessageType.WindowLoaded)
    await Promise.all([this.appReady, this.windowLoaded])
  }
}

export type { Driver }

export async function createDriver() {
  const userDataPath = path.join(
    currentDir,
    'data',
    'tmp',
    `userData-${Date.now()}-${Math.round(Math.random() * 10000)}`,
  )
  await filesManager.ensureDirectoryExists(userDataPath)
  const driver = new Driver(userDataPath)
  await Promise.all([driver.appReady, driver.windowLoaded])
  return driver
}
