import { MessageToWebApp } from '../Shared/IpcMessages'
import { ElectronMainEvents, MainEventHandler } from '../Shared/ElectronMainEvents'
import {
  RemoteBridgeConfig,
  RemoteBridgeInvokeChannel,
  RemoteBridgeSyncChannel,
} from '../Shared/RemoteBridgeChannels'
import { CrossProcessBridge } from './CrossProcessBridge'
const { contextBridge, ipcRenderer } = require('electron')

/**
 * Builds the renderer-facing remote bridge.
 *
 * SECURITY: This no longer uses @electron/remote. Instead of receiving a live
 * main-process object (`getGlobal('RemoteBridge')`), the renderer only gets a
 * plain object whose members forward to specific, allowlisted IPC channels via
 * `ipcRenderer.invoke` (async) and `ipcRenderer.sendSync` (the few values the
 * web app reads synchronously). The renderer therefore cannot reach arbitrary
 * main-process objects, prototypes, or modules.
 */
function buildRemoteBridge(): CrossProcessBridge {
  /**
   * Config values the web app reads synchronously as plain properties
   * (e.g. `electronRemoteBridge.extServerHost`). Fetched once at preload time.
   */
  const config: RemoteBridgeConfig = ipcRenderer.sendSync(RemoteBridgeSyncChannel.GetConfig)

  const I = RemoteBridgeInvokeChannel
  const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

  return {
    // Synchronously-read config values.
    extServerHost: config.extServerHost,
    useNativeKeychain: config.useNativeKeychain,
    isMacOS: config.isMacOS,
    appVersion: config.appVersion,
    useSystemMenuBar: config.useSystemMenuBar,
    rendererPath: config.rendererPath,

    // Synchronous methods (return value consumed synchronously by callers).
    isWindowMaximized: () => ipcRenderer.sendSync(RemoteBridgeSyncChannel.IsWindowMaximized),
    isSpellCheckerManagerAvailable: () => ipcRenderer.sendSync(RemoteBridgeSyncChannel.IsSpellCheckerManagerAvailable),
    getSpellCheckerLanguages: () => ipcRenderer.sendSync(RemoteBridgeSyncChannel.GetSpellCheckerLanguages),

    // Async methods.
    closeWindow: () => invoke(I.CloseWindow),
    minimizeWindow: () => invoke(I.MinimizeWindow),
    maximizeWindow: () => invoke(I.MaximizeWindow),
    unmaximizeWindow: () => invoke(I.UnmaximizeWindow),
    getKeychainValue: () => invoke(I.GetKeychainValue),
    setKeychainValue: (value) => invoke(I.SetKeychainValue, value),
    clearKeychainValue: () => invoke(I.ClearKeychainValue),
    displayAppMenu: () => invoke(I.DisplayAppMenu),
    syncComponents: (components) => invoke(I.SyncComponents, components),
    onSearch: (text) => invoke(I.OnSearch, text),
    destroyAllData: () => invoke(I.DestroyAllData),
    getFilesBackupsMappingFile: (location) => invoke(I.GetFilesBackupsMappingFile, location),
    saveFilesBackupsFile: (location, uuid, metaFile, downloadRequest) =>
      invoke(I.SaveFilesBackupsFile, location, uuid, metaFile, downloadRequest),
    isLegacyFilesBackupsEnabled: () => invoke(I.IsLegacyFilesBackupsEnabled),
    getLegacyFilesBackupsLocation: () => invoke(I.GetLegacyFilesBackupsLocation),
    getFileBackupReadToken: (filePath) => invoke(I.GetFileBackupReadToken, filePath),
    readNextChunk: (nextToken) => invoke(I.ReadNextChunk, nextToken),
    askForMediaAccess: (type) => invoke(I.AskForMediaAccess, type),
    startHomeServer: () => invoke(I.StartHomeServer),
    stopHomeServer: () => invoke(I.StopHomeServer),
    wasLegacyTextBackupsExplicitlyDisabled: () => invoke(I.WasLegacyTextBackupsExplicitlyDisabled),
    getLegacyTextBackupsLocation: () => invoke(I.GetLegacyTextBackupsLocation),
    saveTextBackupData: (location, data) => invoke(I.SaveTextBackupData, location, data),
    savePlaintextNoteBackup: (location, uuid, name, tags, data) =>
      invoke(I.SavePlaintextNoteBackup, location, uuid, name, tags, data),
    openLocation: (path) => invoke(I.OpenLocation, path),
    presentDirectoryPickerForLocationChangeAndTransferOld: (appendPath, oldLocation) =>
      invoke(I.PresentDirectoryPickerForLocationChangeAndTransferOld, appendPath, oldLocation),
    getDirectoryManagerLastErrorMessage: () => invoke(I.GetDirectoryManagerLastErrorMessage),
    getPlaintextBackupsMappingFile: (location) => invoke(I.GetPlaintextBackupsMappingFile, location),
    persistPlaintextBackupsMappingFile: (location) => invoke(I.PersistPlaintextBackupsMappingFile, location),
    getTextBackupsCount: (location) => invoke(I.GetTextBackupsCount, location),
    migrateLegacyFileBackupsToNewStructure: (newPath) => invoke(I.MigrateLegacyFileBackupsToNewStructure, newPath),
    getUserDocumentsDirectory: () => invoke(I.GetUserDocumentsDirectory),
    monitorPlaintextBackupsLocationForChanges: (backupsDirectory) =>
      invoke(I.MonitorPlaintextBackupsLocationForChanges, backupsDirectory),
    joinPaths: (...paths) => invoke(I.JoinPaths, ...paths),
    setHomeServerConfiguration: (configurationJSONString) =>
      invoke(I.SetHomeServerConfiguration, configurationJSONString),
    getHomeServerConfiguration: () => invoke(I.GetHomeServerConfiguration),
    setHomeServerDataLocation: (location) => invoke(I.SetHomeServerDataLocation, location),
    activatePremiumFeatures: (username, subscriptionId) =>
      invoke(I.ActivatePremiumFeatures, username, subscriptionId),
    isHomeServerRunning: () => invoke(I.IsHomeServerRunning),
    getHomeServerLogs: () => invoke(I.GetHomeServerLogs),
    getHomeServerUrl: () => invoke(I.GetHomeServerUrl),
    getHomeServerLastErrorMessage: () => invoke(I.GetHomeServerLastErrorMessage),
    setSpellCheckerLanguages: (codes) => invoke(I.SetSpellCheckerLanguages, codes),
  } as CrossProcessBridge
}

process.once('loaded', function () {
  contextBridge.exposeInMainWorld('electronRemoteBridge', buildRemoteBridge())

  const mainEvents: ElectronMainEvents = {
    setUpdateAvailableHandler: (handler: MainEventHandler) => ipcRenderer.on(MessageToWebApp.UpdateAvailable, handler),

    setWindowBlurredHandler: (handler: MainEventHandler) => ipcRenderer.on(MessageToWebApp.WindowBlurred, handler),

    setWindowFocusedHandler: (handler: MainEventHandler) => ipcRenderer.on(MessageToWebApp.WindowFocused, handler),

    setWatchedDirectoriesChangeHandler: (handler: MainEventHandler) =>
      ipcRenderer.on(MessageToWebApp.WatchedDirectoriesChanges, handler),

    setInstallComponentCompleteHandler: (handler: MainEventHandler) =>
      ipcRenderer.on(MessageToWebApp.InstallComponentComplete, handler),

    setHomeServerStartedHandler: (handler: MainEventHandler) =>
      ipcRenderer.on(MessageToWebApp.HomeServerStarted, handler),

    setConsoleLogHandler: (handler: MainEventHandler) => ipcRenderer.on(MessageToWebApp.ConsoleLog, handler),
  }

  contextBridge.exposeInMainWorld('electronMainEvents', mainEvents)
})
