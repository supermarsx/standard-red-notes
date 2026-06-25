/**
 * IPC channel names for the renderer<->main "remote bridge".
 *
 * This replaces the previous @electron/remote based exposure. The renderer no
 * longer reaches into a main-process global object; instead each bridge member
 * is an explicit, allowlisted IPC channel:
 *
 *  - SYNC channels are read once (or rarely) and must return synchronously to
 *    preserve the existing synchronous API surface consumed by the web app
 *    (e.g. `device.getSpellCheckerLanguages()` is called synchronously from a
 *    React component, and `electronRemoteBridge.extServerHost` is read as a
 *    plain value). They are served via ipcMain.on + event.returnValue.
 *  - ASYNC (invoke) channels back every Promise-returning method.
 *
 * Keeping this list explicit is the whole point of dropping @electron/remote:
 * the renderer can only invoke these specific, reviewed operations.
 */
export const RemoteBridgeSyncChannel = {
  /** Cached config-style values read synchronously by the renderer. */
  GetConfig: 'remote-bridge:get-config',
  IsWindowMaximized: 'remote-bridge:is-window-maximized',
  IsSpellCheckerManagerAvailable: 'remote-bridge:is-spellchecker-manager-available',
  GetSpellCheckerLanguages: 'remote-bridge:get-spellchecker-languages',
} as const

export const RemoteBridgeInvokeChannel = {
  CloseWindow: 'remote-bridge:close-window',
  MinimizeWindow: 'remote-bridge:minimize-window',
  MaximizeWindow: 'remote-bridge:maximize-window',
  UnmaximizeWindow: 'remote-bridge:unmaximize-window',
  GetKeychainValue: 'remote-bridge:get-keychain-value',
  SetKeychainValue: 'remote-bridge:set-keychain-value',
  ClearKeychainValue: 'remote-bridge:clear-keychain-value',
  DisplayAppMenu: 'remote-bridge:display-app-menu',
  SyncComponents: 'remote-bridge:sync-components',
  OnSearch: 'remote-bridge:on-search',
  DestroyAllData: 'remote-bridge:destroy-all-data',
  GetFilesBackupsMappingFile: 'remote-bridge:get-files-backups-mapping-file',
  SaveFilesBackupsFile: 'remote-bridge:save-files-backups-file',
  IsLegacyFilesBackupsEnabled: 'remote-bridge:is-legacy-files-backups-enabled',
  GetLegacyFilesBackupsLocation: 'remote-bridge:get-legacy-files-backups-location',
  GetFileBackupReadToken: 'remote-bridge:get-file-backup-read-token',
  ReadNextChunk: 'remote-bridge:read-next-chunk',
  AskForMediaAccess: 'remote-bridge:ask-for-media-access',
  StartHomeServer: 'remote-bridge:start-home-server',
  StopHomeServer: 'remote-bridge:stop-home-server',
  WasLegacyTextBackupsExplicitlyDisabled: 'remote-bridge:was-legacy-text-backups-explicitly-disabled',
  GetLegacyTextBackupsLocation: 'remote-bridge:get-legacy-text-backups-location',
  SaveTextBackupData: 'remote-bridge:save-text-backup-data',
  SavePlaintextNoteBackup: 'remote-bridge:save-plaintext-note-backup',
  OpenLocation: 'remote-bridge:open-location',
  PresentDirectoryPickerForLocationChangeAndTransferOld:
    'remote-bridge:present-directory-picker-for-location-change-and-transfer-old',
  GetDirectoryManagerLastErrorMessage: 'remote-bridge:get-directory-manager-last-error-message',
  GetPlaintextBackupsMappingFile: 'remote-bridge:get-plaintext-backups-mapping-file',
  PersistPlaintextBackupsMappingFile: 'remote-bridge:persist-plaintext-backups-mapping-file',
  GetTextBackupsCount: 'remote-bridge:get-text-backups-count',
  MigrateLegacyFileBackupsToNewStructure: 'remote-bridge:migrate-legacy-file-backups-to-new-structure',
  GetUserDocumentsDirectory: 'remote-bridge:get-user-documents-directory',
  MonitorPlaintextBackupsLocationForChanges: 'remote-bridge:monitor-plaintext-backups-location-for-changes',
  JoinPaths: 'remote-bridge:join-paths',
  SetHomeServerConfiguration: 'remote-bridge:set-home-server-configuration',
  GetHomeServerConfiguration: 'remote-bridge:get-home-server-configuration',
  SetHomeServerDataLocation: 'remote-bridge:set-home-server-data-location',
  ActivatePremiumFeatures: 'remote-bridge:activate-premium-features',
  IsHomeServerRunning: 'remote-bridge:is-home-server-running',
  GetHomeServerLogs: 'remote-bridge:get-home-server-logs',
  GetHomeServerUrl: 'remote-bridge:get-home-server-url',
  GetHomeServerLastErrorMessage: 'remote-bridge:get-home-server-last-error-message',
  SetSpellCheckerLanguages: 'remote-bridge:set-spellchecker-languages',
} as const

/**
 * The set of synchronously-read config values. Returned as a single object from
 * the GetConfig sync channel so the renderer can populate plain-value getters.
 */
export interface RemoteBridgeConfig {
  extServerHost: string
  useNativeKeychain: boolean
  isMacOS: boolean
  appVersion: string
  useSystemMenuBar: boolean
  rendererPath: string
}
