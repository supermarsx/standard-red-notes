jest.mock('@standardnotes/react-native-utils', () => ({
  __esModule: true,
  default: { exitApp: jest.fn() },
}))
jest.mock('@standardnotes/snjs', () => ({
  Environment: { Mobile: 'mobile' },
  Platform: { Android: 'android', Ios: 'ios' },
  RawStorageKey: {},
  namespacedKey: jest.fn(),
  redactLogValue: jest.fn(),
  removeFromArray: jest.fn(),
}))
jest.mock(
  'ColorSchemeObserverService',
  () => ({
    ColorSchemeObserverService: class {},
  }),
  { virtual: true },
)
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Appearance: { getColorScheme: jest.fn() },
  AppState: { currentState: 'active' },
  Linking: {},
  NativeModules: {},
  PermissionsAndroid: { PERMISSIONS: {} },
  Platform: { OS: 'ios' },
  StatusBar: { setBarStyle: jest.fn() },
}))
jest.mock('react-native-file-viewer', () => ({ __esModule: true, default: {} }))
jest.mock('react-native-fingerprint-scanner', () => ({ __esModule: true, default: {} }))
jest.mock('react-native-flag-secure-android', () => ({ __esModule: true, default: {} }))
jest.mock('react-native-fs', () => ({}))
jest.mock('react-native-privacy-snapshot', () => ({}))
jest.mock('react-native-share', () => ({ __esModule: true, default: {} }))
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  AuthorizationStatus: { AUTHORIZED: 1 },
  default: {},
}))
jest.mock('../AndroidBackHandlerService', () => ({ AndroidBackHandlerService: class {} }))
jest.mock('../AppStateObserverService', () => ({ AppStateObserverService: class {} }))
jest.mock('../PurchaseManager', () => ({ PurchaseManager: {} }))
jest.mock('./Database/Database', () => ({ Database: class {} }))
jest.mock('./Database/LegacyKeyValueStore', () => ({ LegacyKeyValueStore: class {} }))
jest.mock('./Keychain', () => ({ __esModule: true, default: {} }))

import { MobileDevice, MobileDeviceEvent } from './MobileDevice'

describe('MobileDevice runtime reset', () => {
  it('hard reset requests a WebView recreation without clearing storage', async () => {
    const device = Object.create(MobileDevice.prototype) as MobileDevice
    Object.assign(device, { mobileDeviceEventObservers: [] })
    const receiver = jest.fn()
    const clearAllData = jest.spyOn(device, 'clearAllDataFromDevice')
    device.addMobileDeviceEventReceiver(receiver)

    await device.performHardReset()

    expect(receiver).toHaveBeenCalledTimes(1)
    expect(receiver).toHaveBeenCalledWith(MobileDeviceEvent.RequestsWebViewReload)
    expect(clearAllData).not.toHaveBeenCalled()
  })
})
