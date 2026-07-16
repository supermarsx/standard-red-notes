import fs from 'fs'
import path from 'path'
import { app as electronApp } from 'electron'
import { MessageType } from '../../../../test/TestIpcMessage'
import { handleTestMessage } from '../Utils/Testing'
import { isTesting } from '../Utils/Utils'
import { parseDataFile, serializeStoreData } from './createSanitizedStoreData'
import { StoreData } from './StoreKeys'

/**
 * The Store is only ever loaded in the main process (the renderer/preload reach
 * config values over IPC via the RemoteBridge, not by importing this module), so
 * we use the plain main-process `electron.app`. This removes the previous
 * `@electron/remote` fallback that was only relevant when Store was loaded in a
 * renderer context.
 */
export const app = electronApp

export function logError(...message: unknown[]) {
  console.error('store:', ...message)
}

export class Store {
  static instance: Store
  readonly path: string
  readonly data: StoreData

  static getInstance(): Store {
    if (!this.instance) {
      const userDataPath = app.getPath('userData')
      this.instance = new Store(userDataPath)
    }
    return this.instance
  }

  static get<T extends keyof StoreData>(key: T): StoreData[T] {
    return this.getInstance().get(key)
  }

  constructor(userDataPath: string) {
    this.path = path.join(userDataPath, 'user-preferences.json')
    this.data = parseDataFile(this.path)

    if (isTesting()) {
      handleTestMessage(MessageType.StoreSettingsLocation, () => this.path)
      handleTestMessage(MessageType.StoreSet, (key, value) => {
        this.set(key, value)
      })
    }
  }

  get<T extends keyof StoreData>(key: T): StoreData[T] {
    return this.data[key]
  }

  set<T extends keyof StoreData>(key: T, val: StoreData[T]): void {
    this.data[key] = val
    // Write to a temp file then rename into place. rename is atomic on the same
    // volume, so a crash/power-loss mid-write can only leave a throwaway temp
    // file behind and never truncates user-preferences.json — a torn primary
    // file would make parseDataFile silently reset every desktop setting to
    // defaults.
    const tempPath = `${this.path}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, serializeStoreData(this.data))
    fs.renameSync(tempPath, this.path)
  }
}
