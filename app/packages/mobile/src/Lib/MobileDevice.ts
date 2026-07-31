import SNReactNative from '@standardnotes/react-native-utils'
import {
  AppleIAPProductId,
  AppleIAPReceipt,
  ApplicationEvent,
  ApplicationIdentifier,
  DatabaseKeysLoadChunkResponse,
  DatabaseLoadOptions,
  Environment,
  MobileDeviceInterface,
  namespacedKey,
  NamespacedRootKeyInKeychain,
  Platform as SNPlatform,
  RawKeychainValue,
  RawStorageKey,
  redactLogValue,
  removeFromArray,
  TransferPayload,
  UuidString,
} from '@standardnotes/snjs'
import { ColorSchemeObserverService } from 'ColorSchemeObserverService'
import {
  Alert,
  Appearance,
  AppState,
  AppStateStatus,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  StatusBar,
} from 'react-native'
import FileViewer from 'react-native-file-viewer'
import FingerprintScanner from 'react-native-fingerprint-scanner'
import FlagSecure from 'react-native-flag-secure-android'
import {
  DocumentDirectoryPath,
  DownloadDirectoryPath,
  exists,
  MainBundlePath,
  readFile,
  readFileAssets,
  TemporaryDirectoryPath,
  unlink,
  writeFile,
} from 'react-native-fs'
import { hide, show } from 'react-native-privacy-snapshot'
import Share from 'react-native-share'
import { AndroidBackHandlerService } from '../AndroidBackHandlerService'
import { AppStateObserverService } from '../AppStateObserverService'
import { PurchaseManager } from '../PurchaseManager'
import { Database } from './Database/Database'
import { isLegacyIdentifier } from './Database/LegacyIdentifier'
import { LegacyKeyValueStore } from './Database/LegacyKeyValueStore'
import Keychain from './Keychain'
import {
  assertSafeMobileFileName,
  createContainedMobileFilePath,
  createTemporaryMobileFileName,
} from './MobileFilePathSecurity'
import notifee, { AuthorizationStatus, Notification, NotificationSettings } from '@notifee/react-native'

export type BiometricsType = 'Fingerprint' | 'Face ID' | 'Biometrics' | 'Touch ID'

export enum MobileDeviceEvent {
  RequestsWebViewReload = 0,
}

type MobileDeviceEventHandler = (event: MobileDeviceEvent) => void
type ApplicationEventHandler = (event: ApplicationEvent) => void
type NativeLogEvent =
  | 'Notification initialization failed'
  | 'Fido2ApiModule is not available'
  | 'Fido2ApiModule authentication failed'
  | 'Sharing a downloaded file failed'
  | 'Writing a downloaded file failed'
  | 'Could not download file to preview'
  | 'Opening a downloaded file failed'

export class MobileDevice implements MobileDeviceInterface {
  environment: Environment.Mobile = Environment.Mobile
  platform: SNPlatform.Ios | SNPlatform.Android = Platform.OS === 'ios' ? SNPlatform.Ios : SNPlatform.Android
  private applicationEventObservers: ApplicationEventHandler[] = []
  private mobileDeviceEventObservers: MobileDeviceEventHandler[] = []
  public isDarkMode = false
  public statusBarBgColor: string | undefined
  private componentUrls: Map<UuidString, string> = new Map()
  private keyValueStore = new LegacyKeyValueStore()
  private databases = new Map<string, Database>()

  private notificationSettings: NotificationSettings | undefined

  constructor(
    private stateObserverService?: AppStateObserverService,
    private androidBackHandlerService?: AndroidBackHandlerService,
    private colorSchemeService?: ColorSchemeObserverService,
  ) {
    this.initializeNotifications().catch(() => this.logNativeEvent('Notification initialization failed'))
    this.reloadStatusBarStyle(false)
  }

  async initializeNotifications() {
    if (Platform.OS !== 'android') {
      return
    }

    await notifee.createChannel({
      id: 'files',
      name: 'File Upload/Download',
    })

    const didAskForPermission = await this.keyValueStore.getValue<boolean>('didAskForNotificationPermission')

    if (!didAskForPermission) {
      this.notificationSettings = await notifee.requestPermission()
      await this.keyValueStore.set('didAskForNotificationPermission', 'true')
    }

    this.notificationSettings = await notifee.getNotificationSettings()
  }

  async canDisplayNotifications(): Promise<boolean> {
    if (!this.notificationSettings) {
      return false
    }

    return this.notificationSettings.authorizationStatus >= AuthorizationStatus.AUTHORIZED
  }

  async displayNotification(options: Notification): Promise<string> {
    return await notifee.displayNotification({
      ...options,
      android: {
        ...options.android,
        channelId: 'files',
      },
    })
  }

  async cancelNotification(notificationId: string): Promise<void> {
    await notifee.cancelNotification(notificationId)
  }

  async removeRawStorageValuesForIdentifier(identifier: string): Promise<void> {
    await this.removeRawStorageValue(namespacedKey(identifier, RawStorageKey.SnjsVersion))
    await this.removeRawStorageValue(namespacedKey(identifier, RawStorageKey.StorageObject))
  }

  async authenticateWithU2F(authenticationOptionsJSONString: string): Promise<Record<string, unknown> | null> {
    const { Fido2ApiModule } = NativeModules

    if (!Fido2ApiModule) {
      this.logNativeEvent('Fido2ApiModule is not available')

      return null
    }

    try {
      const response = await Fido2ApiModule.promptForU2FAuthentication(authenticationOptionsJSONString)

      return response
    } catch {
      this.logNativeEvent('Fido2ApiModule authentication failed')

      return null
    }
  }

  purchaseSubscriptionIAP(plan: AppleIAPProductId): Promise<AppleIAPReceipt | undefined> {
    return PurchaseManager.getInstance().purchase(plan)
  }

  private findOrCreateDatabase(identifier: ApplicationIdentifier): Database {
    const existing = this.databases.get(identifier)
    if (existing) {
      return existing
    }

    const newDb = new Database(identifier)
    this.databases.set(identifier, newDb)
    return newDb
  }

  deinit() {
    this.stateObserverService?.deinit()
    ;(this.stateObserverService as unknown) = undefined
    this.androidBackHandlerService?.deinit()
    ;(this.androidBackHandlerService as unknown) = undefined
    this.colorSchemeService?.deinit()
    ;(this.colorSchemeService as unknown) = undefined
  }

  consoleLog(...args: unknown[]): void {
    const forwardedCount =
      args.length === 1 && typeof args[0] === 'number' && Number.isSafeInteger(args[0]) ? args[0] : args.length
    const argumentCount = Math.max(0, Math.min(forwardedCount, 1_000))
    // eslint-disable-next-line no-console
    console.log('Web client log event received', { argumentCount })
  }

  private logNativeEvent(event: NativeLogEvent): void {
    // eslint-disable-next-line no-console
    console.log(redactLogValue(event))
  }

  public async getJsonParsedRawStorageValue(key: string): Promise<unknown | undefined> {
    const value = await this.getRawStorageValue(key)
    if (value == undefined) {
      return undefined
    }
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  getRawStorageValue(key: string): Promise<string | undefined> {
    return this.keyValueStore.getValue(key)
  }

  setRawStorageValue(key: string, value: string): Promise<void> {
    return this.keyValueStore.set(key, value)
  }

  removeRawStorageValue(key: string): Promise<void> {
    return this.keyValueStore.delete(key)
  }

  removeAllRawStorageValues(): Promise<void> {
    return this.keyValueStore.deleteAll()
  }

  openDatabase(): Promise<{ isNewDatabase?: boolean | undefined } | undefined> {
    return Promise.resolve({ isNewDatabase: false })
  }

  getDatabaseLoadChunks(options: DatabaseLoadOptions, identifier: string): Promise<DatabaseKeysLoadChunkResponse> {
    return this.findOrCreateDatabase(identifier).getLoadChunks(options)
  }

  async getAllDatabaseEntries<T extends TransferPayload = TransferPayload>(
    identifier: ApplicationIdentifier,
  ): Promise<T[]> {
    return this.findOrCreateDatabase(identifier).getAllEntries()
  }

  async getDatabaseEntries<T extends TransferPayload = TransferPayload>(
    identifier: ApplicationIdentifier,
    keys: string[],
  ): Promise<T[]> {
    return this.findOrCreateDatabase(identifier).multiGet<T>(keys)
  }

  saveDatabaseEntry(payload: TransferPayload, identifier: ApplicationIdentifier): Promise<void> {
    return this.saveDatabaseEntries([payload], identifier)
  }

  async saveDatabaseEntries(payloads: TransferPayload[], identifier: ApplicationIdentifier): Promise<void> {
    return this.findOrCreateDatabase(identifier).setItems(payloads)
  }

  removeDatabaseEntry(id: string, identifier: ApplicationIdentifier): Promise<void> {
    return this.findOrCreateDatabase(identifier).deleteItem(id)
  }

  async removeAllDatabaseEntries(identifier: ApplicationIdentifier): Promise<void> {
    return this.findOrCreateDatabase(identifier).deleteAll()
  }

  async getDeviceBiometricsAvailability() {
    try {
      await FingerprintScanner.isSensorAvailable()
      return true
    } catch {
      return false
    }
  }

  async authenticateWithBiometrics() {
    this.stateObserverService?.beginIgnoringStateChanges()

    const result = await new Promise<boolean>((resolve) => {
      if (Platform.OS === 'android') {
        FingerprintScanner.authenticate({
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore ts type does not exist for deviceCredentialAllowed
          deviceCredentialAllowed: true,
          description: 'Biometrics are required to access your notes.',
        })
          .then(() => {
            FingerprintScanner.release()
            resolve(true)
          })
          .catch((error) => {
            FingerprintScanner.release()
            if (error.name === 'DeviceLocked') {
              Alert.alert('Unsuccessful', 'Authentication failed. Wait 30 seconds to try again.')
            } else {
              Alert.alert('Unsuccessful', 'Authentication failed. Tap to try again.')
            }
            resolve(false)
          })
      } else {
        // iOS
        FingerprintScanner.authenticate({
          fallbackEnabled: true,
          description: 'This is required to access your notes.',
        })
          .then(() => {
            FingerprintScanner.release()
            resolve(true)
          })
          .catch((error_1) => {
            FingerprintScanner.release()
            if (error_1.name !== 'SystemCancel') {
              if (error_1.name !== 'UserCancel') {
                Alert.alert('Unsuccessful')
              } else {
                Alert.alert('Unsuccessful', 'Authentication failed. Tap to try again.')
              }
            }
            resolve(false)
          })
      }
    })

    this.stateObserverService?.stopIgnoringStateChanges()

    return result
  }

  async getNamespacedKeychainValue(
    identifier: ApplicationIdentifier,
  ): Promise<NamespacedRootKeyInKeychain | undefined> {
    const keychain = await this.getRawKeychainValue()

    if (!keychain) {
      return
    }

    const namespacedValue = keychain[identifier]

    if (!namespacedValue && isLegacyIdentifier(identifier)) {
      return keychain as unknown as NamespacedRootKeyInKeychain
    }

    return namespacedValue
  }

  async setNamespacedKeychainValue(
    value: NamespacedRootKeyInKeychain,
    identifier: ApplicationIdentifier,
  ): Promise<void> {
    let keychain = await this.getRawKeychainValue()

    if (!keychain) {
      keychain = {}
    }

    await Keychain.setKeys({
      ...keychain,
      [identifier]: value,
    })
  }

  async clearNamespacedKeychainValue(identifier: ApplicationIdentifier): Promise<void> {
    const keychain = await this.getRawKeychainValue()

    if (!keychain) {
      return
    }

    delete keychain[identifier]
    await Keychain.setKeys(keychain)
  }

  async getRawKeychainValue(): Promise<RawKeychainValue | undefined> {
    const result = await Keychain.getKeys()

    if (result === null) {
      return undefined
    }

    return result
  }

  async clearRawKeychainValue(): Promise<void> {
    await Keychain.clearKeys()
  }

  setAndroidScreenshotPrivacy(enable: boolean): void {
    if (Platform.OS === 'android') {
      if (enable) {
        FlagSecure.activate()
      } else {
        FlagSecure.deactivate()
      }
    }
  }

  openUrl(url: string) {
    const showAlert = () => {
      Alert.alert('Unable to Open', `Unable to open URL ${url}.`)
    }

    Linking.canOpenURL(url)
      .then((supported) => {
        if (!supported) {
          showAlert()
          return
        } else {
          return Linking.openURL(url)
        }
      })
      .catch(() => showAlert())
  }

  async clearAllDataFromDevice(workspaceIdentifiers: string[]): Promise<{ killsApplication: boolean }> {
    const identifiers = new Set([...workspaceIdentifiers, ...this.databases.keys()])

    for (const identifier of identifiers) {
      await this.findOrCreateDatabase(identifier).deleteAll()
      this.databases.delete(identifier)
    }

    await this.removeAllRawStorageValues()

    await this.clearRawKeychainValue()

    return { killsApplication: false }
  }

  performSoftReset(): Promise<void> {
    this.notifyMobileDeviceEvent(MobileDeviceEvent.RequestsWebViewReload)

    return Promise.resolve()
  }

  addMobileDeviceEventReceiver(handler: MobileDeviceEventHandler): () => void {
    this.mobileDeviceEventObservers.push(handler)

    const thislessObservers = this.mobileDeviceEventObservers

    return () => {
      removeFromArray(thislessObservers, handler)
    }
  }

  addApplicationEventReceiver(handler: ApplicationEventHandler): () => void {
    this.applicationEventObservers.push(handler)

    const thislessObservers = this.applicationEventObservers

    return () => {
      removeFromArray(thislessObservers, handler)
    }
  }

  handleThemeSchemeChange(isDark: boolean, bgColor: string): void {
    this.isDarkMode = isDark
    this.statusBarBgColor = bgColor

    this.reloadStatusBarStyle()
  }

  reloadStatusBarStyle(animated = true) {
    if (this.statusBarBgColor && Platform.OS === 'android') {
      StatusBar.setBackgroundColor(this.statusBarBgColor, animated)
    }
    StatusBar.setBarStyle(this.isDarkMode ? 'light-content' : 'dark-content', animated)
  }

  private notifyMobileDeviceEvent(event: MobileDeviceEvent): void {
    for (const handler of this.mobileDeviceEventObservers) {
      handler(event)
    }
  }

  notifyApplicationEvent(event: ApplicationEvent): void {
    for (const handler of this.applicationEventObservers) {
      handler(event)
    }
  }

  performHardReset(): Promise<void> {
    return this.performSoftReset()
  }

  isDeviceDestroyed() {
    return false
  }

  private async deleteFileAtPathIfExists(path: string) {
    if (await exists(path)) {
      await unlink(path)
    }
  }

  async shareBase64AsFile(base64: string, filename: string) {
    let downloadedTempFilePath: string | undefined
    try {
      downloadedTempFilePath = await this.downloadBase64AsFile(base64, filename, true)
      if (!downloadedTempFilePath) {
        return
      }
      await Share.open({
        url: `file://${downloadedTempFilePath}`,
        failOnCancel: false,
      })
    } catch {
      this.logNativeEvent('Sharing a downloaded file failed')
    } finally {
      if (downloadedTempFilePath) {
        void this.deleteFileAtPathIfExists(downloadedTempFilePath)
      }
    }
  }

  private getFileDestinationPath(filename: string, saveInTempLocation: boolean): string {
    const safeFilename = assertSafeMobileFileName(filename)
    const directory = saveInTempLocation
      ? TemporaryDirectoryPath
      : Platform.OS === 'android'
        ? DownloadDirectoryPath
        : DocumentDirectoryPath
    const destinationFilename = saveInTempLocation
      ? createTemporaryMobileFileName(safeFilename, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      : safeFilename

    return createContainedMobileFilePath(directory, destinationFilename)
  }

  async downloadBase64AsFile(
    base64: string,
    filename: string,
    saveInTempLocation = false,
  ): Promise<string | undefined> {
    try {
      const path = this.getFileDestinationPath(filename, saveInTempLocation)

      if (Platform.OS === 'android' && !saveInTempLocation) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
      }

      await this.deleteFileAtPathIfExists(path)
      await writeFile(path, base64.replace(/data.*base64,/, ''), 'base64')
      return path
    } catch {
      this.logNativeEvent('Writing a downloaded file failed')
    }
  }

  async getNativeThemeCSS(identifier: string): Promise<string | undefined> {
    let path = `Web.bundle/src/web-src/components/assets/${identifier}/index.css`
    if (Platform.OS === 'ios') {
      path = `${MainBundlePath}/${path}`
    }
    const content = Platform.OS === 'android' ? readFileAssets(path) : readFile(path)
    return content
  }

  async previewFile(base64: string, filename: string): Promise<boolean> {
    const tempLocation = await this.downloadBase64AsFile(base64, filename, true)

    if (!tempLocation) {
      this.logNativeEvent('Could not download file to preview')
      return false
    }

    try {
      await FileViewer.open(tempLocation, {
        onDismiss: async () => {
          await this.deleteFileAtPathIfExists(tempLocation)
        },
      })
    } catch {
      this.logNativeEvent('Opening a downloaded file failed')
      await this.deleteFileAtPathIfExists(tempLocation)
      return false
    }

    return true
  }

  exitApp(shouldConfirm?: boolean) {
    if (!shouldConfirm) {
      SNReactNative.exitApp()
      return
    }

    Alert.alert(
      'Close app',
      'Do you want to close the app?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: async () => {},
        },
        {
          text: 'Close',
          style: 'destructive',
          onPress: async () => {
            SNReactNative.exitApp()
          },
        },
      ],
      {
        cancelable: true,
      },
    )
  }

  registerComponentUrl(componentUuid: UuidString, componentUrl: string) {
    this.componentUrls.set(componentUuid, componentUrl)
  }

  deregisterComponentUrl(componentUuid: UuidString) {
    this.componentUrls.delete(componentUuid)
  }

  isUrlRegisteredComponentUrl(url: string): boolean {
    return Array.from(this.componentUrls.values()).includes(url)
  }

  async getAppState(): Promise<AppStateStatus> {
    return AppState.currentState
  }

  async getColorScheme(): Promise<'light' | 'dark' | null | undefined> {
    const scheme = Appearance.getColorScheme()
    return scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : undefined
  }

  hideMobileInterfaceFromScreenshots(): void {
    hide()
    this.setAndroidScreenshotPrivacy(true)
  }

  stopHidingMobileInterfaceFromScreenshots(): void {
    show()
    this.setAndroidScreenshotPrivacy(false)
  }
}
