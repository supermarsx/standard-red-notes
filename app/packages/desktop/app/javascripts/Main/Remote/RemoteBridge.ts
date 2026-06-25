import { CrossProcessBridge } from '../../Renderer/CrossProcessBridge'
import { Store } from '../Store/Store'
import { StoreKeys } from '../Store/StoreKeys'

const path = require('path')
const rendererPath = path.join('file://', __dirname, '/renderer.js')

import {
  FileBackupsDevice,
  FileBackupsMapping,
  FileBackupReadToken,
  FileBackupReadChunkResponse,
  HomeServerManagerInterface,
  PlaintextBackupsMapping,
  DirectoryManagerInterface,
} from '@web/Application/Device/DesktopSnjsExports'
import { app, BrowserWindow, ipcMain } from 'electron'
import { KeychainInterface } from '../Keychain/KeychainInterface'
import { MenuManagerInterface } from '../Menus/MenuManagerInterface'
import { Component, PackageManagerInterface } from '../Packages/PackageManagerInterface'
import { SearchManagerInterface } from '../Search/SearchManagerInterface'
import { RemoteDataInterface } from './DataInterface'
import { MediaManagerInterface } from '../Media/MediaManagerInterface'
import { SpellcheckerLanguage, SpellcheckerManager } from '../SpellcheckerManager'
import {
  RemoteBridgeConfig,
  RemoteBridgeInvokeChannel,
  RemoteBridgeSyncChannel,
} from '../../Shared/RemoteBridgeChannels'

/**
 * Validates that a value received over IPC is a non-empty string. Throws on
 * anything else so a malformed/hostile IPC payload cannot be passed straight
 * into fs/path operations on the main process.
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`RemoteBridge: expected non-empty string for "${name}"`)
  }
  return value
}

function requireOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return requireString(value, name)
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`RemoteBridge: expected string[] for "${name}"`)
  }
  return value as string[]
}

/**
 * The RemoteBridge exposes a small, explicitly allowlisted set of main-process
 * operations to the renderer.
 *
 * SECURITY NOTE: this used to be exposed via @electron/remote
 * (`getGlobal('RemoteBridge')` from the preload, exposing a live main-process
 * object graph to the renderer). That has been removed. Each operation is now a
 * discrete, reviewed IPC channel registered in `registerHandlers()` and invoked
 * from the preload via `ipcRenderer.invoke` / `ipcRenderer.sendSync`. The
 * renderer can therefore only call these specific operations and never reach
 * arbitrary main-process objects/prototypes.
 *
 * RemoteBridge is declared and created on the main process only.
 */
export class RemoteBridge implements CrossProcessBridge {
  constructor(
    private window: BrowserWindow,
    private keychain: KeychainInterface,
    private packages: PackageManagerInterface,
    private search: SearchManagerInterface,
    private data: RemoteDataInterface,
    private menus: MenuManagerInterface,
    private fileBackups: FileBackupsDevice,
    private media: MediaManagerInterface,
    private homeServerManager: HomeServerManagerInterface,
    private directoryManager: DirectoryManagerInterface,
    private spellcheckerManager: SpellcheckerManager | undefined,
  ) {}

  /**
   * Synchronously-read configuration values. The renderer reads these as plain
   * values (e.g. `electronRemoteBridge.extServerHost`) so they are fetched once
   * over a synchronous IPC channel at preload time.
   */
  get config(): RemoteBridgeConfig {
    return {
      extServerHost: this.extServerHost,
      useNativeKeychain: this.useNativeKeychain,
      isMacOS: this.isMacOS,
      appVersion: this.appVersion,
      useSystemMenuBar: this.useSystemMenuBar,
      rendererPath: this.rendererPath,
    }
  }

  /**
   * Registers the allowlisted IPC channels backing the renderer bridge.
   *
   * IPC handlers (ipcMain.handle/on) are GLOBAL per channel, but a fresh
   * RemoteBridge is constructed for every window. To preserve the previous
   * `global.RemoteBridge = new RemoteBridge(...)` ("most-recently-created window
   * wins") semantics without registering duplicate handlers, the channels are
   * bound once to a mutable holder; constructing a new window repoints the
   * holder at the latest bridge via `RemoteBridge.setActiveBridge`. Window
   * control calls still resolve the *focused* window at call time (see
   * `activeWindow`), so window-control correctness is unaffected.
   */
  static setActiveBridge(bridge: RemoteBridge): void {
    RemoteBridge.activeBridge = bridge
    if (!RemoteBridge.handlersRegistered) {
      RemoteBridge.handlersRegistered = true
      bridge.registerHandlers()
    }
  }

  private static activeBridge: RemoteBridge | undefined
  private static handlersRegistered = false

  /** Resolves the bridge that should service IPC calls. */
  private static current(): RemoteBridge {
    if (!RemoteBridge.activeBridge) {
      throw new Error('RemoteBridge: no active bridge registered')
    }
    return RemoteBridge.activeBridge
  }

  /**
   * Registers the allowlisted IPC channels. Called once via setActiveBridge.
   * Every handler dispatches to RemoteBridge.current() so it always targets the
   * most-recently-created window's services (matching prior behavior).
   */
  registerHandlers(): void {
    /**
     * Dispatch every channel through the active bridge (most-recently-created
     * window), not `this`, so a new window's services take over as before.
     */
    const b = () => RemoteBridge.current()

    /** Synchronous channels (renderer reads return values synchronously). */
    ipcMain.on(RemoteBridgeSyncChannel.GetConfig, (event) => {
      event.returnValue = b().config
    })
    ipcMain.on(RemoteBridgeSyncChannel.IsWindowMaximized, (event) => {
      event.returnValue = b().isWindowMaximized()
    })
    ipcMain.on(RemoteBridgeSyncChannel.IsSpellCheckerManagerAvailable, (event) => {
      event.returnValue = b().isSpellCheckerManagerAvailable()
    })
    ipcMain.on(RemoteBridgeSyncChannel.GetSpellCheckerLanguages, (event) => {
      event.returnValue = b().getSpellCheckerLanguages()
    })

    /** Async (invoke) channels. */
    const I = RemoteBridgeInvokeChannel
    ipcMain.handle(I.CloseWindow, () => b().closeWindow())
    ipcMain.handle(I.MinimizeWindow, () => b().minimizeWindow())
    ipcMain.handle(I.MaximizeWindow, () => b().maximizeWindow())
    ipcMain.handle(I.UnmaximizeWindow, () => b().unmaximizeWindow())
    ipcMain.handle(I.GetKeychainValue, () => b().getKeychainValue())
    ipcMain.handle(I.SetKeychainValue, (_e, value: unknown) => b().setKeychainValue(value))
    ipcMain.handle(I.ClearKeychainValue, () => b().clearKeychainValue())
    ipcMain.handle(I.DisplayAppMenu, () => b().displayAppMenu())
    ipcMain.handle(I.SyncComponents, (_e, components: unknown) => b().syncComponents(components as Component[]))
    ipcMain.handle(I.OnSearch, (_e, text: unknown) => b().onSearch(requireString(text, 'text')))
    ipcMain.handle(I.DestroyAllData, () => b().destroyAllData())
    ipcMain.handle(I.GetFilesBackupsMappingFile, (_e, location: unknown) =>
      b().getFilesBackupsMappingFile(requireString(location, 'location')),
    )
    ipcMain.handle(
      I.SaveFilesBackupsFile,
      (_e, location: unknown, uuid: unknown, metaFile: unknown, downloadRequest: unknown) =>
        b().saveFilesBackupsFile(
          requireString(location, 'location'),
          requireString(uuid, 'uuid'),
          requireString(metaFile, 'metaFile'),
          b().validateDownloadRequest(downloadRequest),
        ),
    )
    ipcMain.handle(I.IsLegacyFilesBackupsEnabled, () => b().isLegacyFilesBackupsEnabled())
    ipcMain.handle(I.GetLegacyFilesBackupsLocation, () => b().getLegacyFilesBackupsLocation())
    ipcMain.handle(I.GetFileBackupReadToken, (_e, filePath: unknown) =>
      b().getFileBackupReadToken(requireString(filePath, 'filePath')),
    )
    ipcMain.handle(I.ReadNextChunk, (_e, nextToken: unknown) =>
      b().readNextChunk(requireString(nextToken, 'nextToken')),
    )
    ipcMain.handle(I.AskForMediaAccess, (_e, type: unknown) => {
      if (type !== 'camera' && type !== 'microphone') {
        throw new Error('RemoteBridge: invalid media access type')
      }
      return b().askForMediaAccess(type)
    })
    ipcMain.handle(I.StartHomeServer, () => b().startHomeServer())
    ipcMain.handle(I.StopHomeServer, () => b().stopHomeServer())
    ipcMain.handle(I.WasLegacyTextBackupsExplicitlyDisabled, () => b().wasLegacyTextBackupsExplicitlyDisabled())
    ipcMain.handle(I.GetLegacyTextBackupsLocation, () => b().getLegacyTextBackupsLocation())
    ipcMain.handle(I.SaveTextBackupData, (_e, location: unknown, data: unknown) =>
      b().saveTextBackupData(requireString(location, 'location'), requireString(data, 'data')),
    )
    ipcMain.handle(
      I.SavePlaintextNoteBackup,
      (_e, location: unknown, uuid: unknown, name: unknown, tags: unknown, data: unknown) =>
        b().savePlaintextNoteBackup(
          requireString(location, 'location'),
          requireString(uuid, 'uuid'),
          requireString(name, 'name'),
          requireStringArray(tags, 'tags'),
          requireString(data, 'data'),
        ),
    )
    ipcMain.handle(I.OpenLocation, (_e, path: unknown) => b().openLocation(requireString(path, 'path')))
    ipcMain.handle(
      I.PresentDirectoryPickerForLocationChangeAndTransferOld,
      (_e, appendPath: unknown, oldLocation: unknown) =>
        b().presentDirectoryPickerForLocationChangeAndTransferOld(
          requireString(appendPath, 'appendPath'),
          requireOptionalString(oldLocation, 'oldLocation'),
        ),
    )
    ipcMain.handle(I.GetDirectoryManagerLastErrorMessage, () => b().getDirectoryManagerLastErrorMessage())
    ipcMain.handle(I.GetPlaintextBackupsMappingFile, (_e, location: unknown) =>
      b().getPlaintextBackupsMappingFile(requireString(location, 'location')),
    )
    ipcMain.handle(I.PersistPlaintextBackupsMappingFile, (_e, location: unknown) =>
      b().persistPlaintextBackupsMappingFile(requireString(location, 'location')),
    )
    ipcMain.handle(I.GetTextBackupsCount, (_e, location: unknown) =>
      b().getTextBackupsCount(requireString(location, 'location')),
    )
    ipcMain.handle(I.MigrateLegacyFileBackupsToNewStructure, (_e, newPath: unknown) =>
      b().migrateLegacyFileBackupsToNewStructure(requireString(newPath, 'newPath')),
    )
    ipcMain.handle(I.GetUserDocumentsDirectory, () => b().getUserDocumentsDirectory())
    ipcMain.handle(I.MonitorPlaintextBackupsLocationForChanges, (_e, backupsDirectory: unknown) =>
      b().monitorPlaintextBackupsLocationForChanges(requireString(backupsDirectory, 'backupsDirectory')),
    )
    ipcMain.handle(I.JoinPaths, (_e, ...paths: unknown[]) => b().joinPaths(...requireStringArray(paths, 'paths')))
    ipcMain.handle(I.SetHomeServerConfiguration, (_e, configurationJSONString: unknown) =>
      b().setHomeServerConfiguration(requireString(configurationJSONString, 'configurationJSONString')),
    )
    ipcMain.handle(I.GetHomeServerConfiguration, () => b().getHomeServerConfiguration())
    ipcMain.handle(I.SetHomeServerDataLocation, (_e, location: unknown) =>
      b().setHomeServerDataLocation(requireString(location, 'location')),
    )
    ipcMain.handle(I.ActivatePremiumFeatures, (_e, username: unknown, subscriptionId: unknown) => {
      if (typeof subscriptionId !== 'number') {
        throw new Error('RemoteBridge: subscriptionId must be a number')
      }
      return b().activatePremiumFeatures(requireString(username, 'username'), subscriptionId)
    })
    ipcMain.handle(I.IsHomeServerRunning, () => b().isHomeServerRunning())
    ipcMain.handle(I.GetHomeServerLogs, () => b().getHomeServerLogs())
    ipcMain.handle(I.GetHomeServerUrl, () => b().getHomeServerUrl())
    ipcMain.handle(I.GetHomeServerLastErrorMessage, () => b().getHomeServerLastErrorMessage())
    ipcMain.handle(I.SetSpellCheckerLanguages, (_e, codes: unknown) =>
      b().setSpellCheckerLanguages(requireStringArray(codes, 'codes')),
    )
  }

  private validateDownloadRequest(downloadRequest: unknown): {
    chunkSizes: number[]
    valetToken: string
    url: string
  } {
    if (typeof downloadRequest !== 'object' || downloadRequest === null) {
      throw new Error('RemoteBridge: invalid downloadRequest')
    }
    const request = downloadRequest as { chunkSizes?: unknown; valetToken?: unknown; url?: unknown }
    if (!Array.isArray(request.chunkSizes) || request.chunkSizes.some((size) => typeof size !== 'number')) {
      throw new Error('RemoteBridge: downloadRequest.chunkSizes must be number[]')
    }
    return {
      chunkSizes: request.chunkSizes as number[],
      valetToken: requireString(request.valetToken, 'downloadRequest.valetToken'),
      url: requireString(request.url, 'downloadRequest.url'),
    }
  }

  get extServerHost() {
    return Store.get(StoreKeys.ExtServerHost)
  }

  get useNativeKeychain() {
    return Store.get(StoreKeys.UseNativeKeychain) ?? true
  }

  get rendererPath() {
    return rendererPath
  }

  get isMacOS() {
    return process.platform === 'darwin'
  }

  get appVersion() {
    return app.getVersion()
  }

  get useSystemMenuBar() {
    return Store.get(StoreKeys.UseSystemMenuBar)
  }

  /**
   * Resolves the BrowserWindow a window-control call should target. Because the
   * RemoteBridge is a single global shared by every window's preload, calls must
   * act on the window the user is currently interacting with rather than the
   * window this bridge was constructed for. Falls back to the constructor window.
   */
  private get activeWindow(): BrowserWindow {
    return BrowserWindow.getFocusedWindow() ?? this.window
  }

  closeWindow() {
    this.activeWindow.close()
  }

  minimizeWindow() {
    this.activeWindow.minimize()
  }

  maximizeWindow() {
    this.activeWindow.maximize()
  }

  unmaximizeWindow() {
    this.activeWindow.unmaximize()
  }

  isWindowMaximized() {
    return this.activeWindow.isMaximized()
  }

  async getKeychainValue() {
    return this.keychain.getKeychainValue()
  }

  async setKeychainValue(value: unknown) {
    return this.keychain.setKeychainValue(value)
  }

  async clearKeychainValue() {
    return this.keychain.clearKeychainValue()
  }

  syncComponents(components: Component[]) {
    void this.packages.syncComponents(components)
  }

  onSearch(text: string) {
    this.search.findInPage(text)
  }

  destroyAllData() {
    this.data.destroySensitiveDirectories()
  }

  displayAppMenu() {
    this.menus.popupMenu()
  }

  getFilesBackupsMappingFile(location: string): Promise<FileBackupsMapping> {
    return this.fileBackups.getFilesBackupsMappingFile(location)
  }

  saveFilesBackupsFile(
    location: string,
    uuid: string,
    metaFile: string,
    downloadRequest: {
      chunkSizes: number[]
      valetToken: string
      url: string
    },
  ): Promise<'success' | 'failed'> {
    return this.fileBackups.saveFilesBackupsFile(location, uuid, metaFile, downloadRequest)
  }

  getFileBackupReadToken(filePath: string): Promise<FileBackupReadToken> {
    return this.fileBackups.getFileBackupReadToken(filePath)
  }

  readNextChunk(nextToken: string): Promise<FileBackupReadChunkResponse> {
    return this.fileBackups.readNextChunk(nextToken)
  }

  public isLegacyFilesBackupsEnabled(): Promise<boolean> {
    return this.fileBackups.isLegacyFilesBackupsEnabled()
  }

  public getLegacyFilesBackupsLocation(): Promise<string | undefined> {
    return this.fileBackups.getLegacyFilesBackupsLocation()
  }

  wasLegacyTextBackupsExplicitlyDisabled(): Promise<boolean> {
    return this.fileBackups.wasLegacyTextBackupsExplicitlyDisabled()
  }

  getLegacyTextBackupsLocation(): Promise<string | undefined> {
    return this.fileBackups.getLegacyTextBackupsLocation()
  }

  saveTextBackupData(location: string, data: string): Promise<void> {
    return this.fileBackups.saveTextBackupData(location, data)
  }

  savePlaintextNoteBackup(location: string, uuid: string, name: string, tags: string[], data: string): Promise<void> {
    return this.fileBackups.savePlaintextNoteBackup(location, uuid, name, tags, data)
  }

  async openLocation(path: string): Promise<void> {
    return this.directoryManager.openLocation(path)
  }

  async presentDirectoryPickerForLocationChangeAndTransferOld(
    appendPath: string,
    oldLocation?: string | undefined,
  ): Promise<string | undefined> {
    return this.directoryManager.presentDirectoryPickerForLocationChangeAndTransferOld(appendPath, oldLocation)
  }

  async getDirectoryManagerLastErrorMessage(): Promise<string | undefined> {
    return this.directoryManager.getDirectoryManagerLastErrorMessage()
  }

  getPlaintextBackupsMappingFile(location: string): Promise<PlaintextBackupsMapping> {
    return this.fileBackups.getPlaintextBackupsMappingFile(location)
  }

  persistPlaintextBackupsMappingFile(location: string): Promise<void> {
    return this.fileBackups.persistPlaintextBackupsMappingFile(location)
  }

  getTextBackupsCount(location: string): Promise<number> {
    return this.fileBackups.getTextBackupsCount(location)
  }

  migrateLegacyFileBackupsToNewStructure(newPath: string): Promise<void> {
    return this.fileBackups.migrateLegacyFileBackupsToNewStructure(newPath)
  }

  getUserDocumentsDirectory(): Promise<string | undefined> {
    return this.fileBackups.getUserDocumentsDirectory()
  }

  monitorPlaintextBackupsLocationForChanges(backupsDirectory: string): Promise<void> {
    return this.fileBackups.monitorPlaintextBackupsLocationForChanges(backupsDirectory)
  }

  joinPaths(...paths: string[]): Promise<string> {
    return this.fileBackups.joinPaths(...paths)
  }

  askForMediaAccess(type: 'camera' | 'microphone'): Promise<boolean> {
    return this.media.askForMediaAccess(type)
  }

  async startHomeServer(): Promise<string | undefined> {
    return this.homeServerManager.startHomeServer()
  }

  async stopHomeServer(): Promise<string | undefined> {
    return this.homeServerManager.stopHomeServer()
  }

  async setHomeServerConfiguration(configurationJSONString: string): Promise<void> {
    return this.homeServerManager.setHomeServerConfiguration(configurationJSONString)
  }

  async getHomeServerConfiguration(): Promise<string | undefined> {
    return this.homeServerManager.getHomeServerConfiguration()
  }

  async setHomeServerDataLocation(location: string): Promise<void> {
    return this.homeServerManager.setHomeServerDataLocation(location)
  }

  async activatePremiumFeatures(username: string, subscriptionId: number): Promise<string | undefined> {
    return this.homeServerManager.activatePremiumFeatures(username, subscriptionId)
  }

  async isHomeServerRunning(): Promise<boolean> {
    return this.homeServerManager.isHomeServerRunning()
  }

  async getHomeServerLogs(): Promise<string[]> {
    return this.homeServerManager.getHomeServerLogs()
  }

  async getHomeServerUrl(): Promise<string | undefined> {
    return this.homeServerManager.getHomeServerUrl()
  }

  async getHomeServerLastErrorMessage(): Promise<string | undefined> {
    return this.homeServerManager.getHomeServerLastErrorMessage()
  }

  /**
   * Returns false when the spellchecker languages cannot be chosen by the app,
   * i.e. on macOS where the OS owns spellchecking and the manager is undefined.
   */
  isSpellCheckerManagerAvailable(): boolean {
    return this.spellcheckerManager !== undefined
  }

  getSpellCheckerLanguages(): SpellcheckerLanguage[] {
    if (!this.spellcheckerManager) {
      return []
    }
    return this.spellcheckerManager.languages()
  }

  setSpellCheckerLanguages(codes: string[]): void {
    this.spellcheckerManager?.setLanguages(codes)
  }
}
