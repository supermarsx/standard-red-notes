const mockDatabaseDeleteAll = jest.fn()

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
jest.mock('./Database/Database', () => ({
  Database: class {
    constructor(private mockIdentifier: string) {}

    deleteAll() {
      return mockDatabaseDeleteAll(this.mockIdentifier)
    }
  },
}))
jest.mock('./Database/LegacyKeyValueStore', () => ({ LegacyKeyValueStore: class {} }))
jest.mock('./Keychain', () => ({ __esModule: true, default: {} }))

import { MobileDevice, MobileDeviceEvent } from './MobileDevice'

describe('MobileDevice runtime reset', () => {
  function createDevice(rawValues = new Map<string, string>(), events: string[] = []) {
    const keyValueStore = {
      deleteAll: jest.fn(async () => {
        events.push('raw-storage')
        rawValues.clear()
      }),
    }
    const clearRawKeychainValue = jest.fn(async () => {
      events.push('keychain')
    })
    const databases = new Map<string, { deleteAll: () => Promise<void> }>()
    const device = Object.create(MobileDevice.prototype) as MobileDevice
    Object.assign(device, {
      databases,
      keyValueStore,
      mobileDeviceEventObservers: [],
      clearRawKeychainValue,
    })

    return { clearRawKeychainValue, databases, device, keyValueStore }
  }

  it('erases supplied and cached workspace databases before raw storage and keychain', async () => {
    const events: string[] = []
    const rawValues = new Map([
      ['unknown-native-row', 'must also be erased'],
      ['descriptor-record', 'workspace metadata'],
    ])
    const { databases, device, keyValueStore } = createDevice(rawValues, events)
    databases.set('cached-workspace', {
      deleteAll: jest.fn(async () => {
        events.push('database:cached-workspace')
      }),
    })
    mockDatabaseDeleteAll.mockImplementation(async (identifier: string) => {
      events.push(`database:${identifier}`)
    })
    await expect(
      device.clearAllDataFromDevice(['workspace-b', 'standardnotes', 'workspace-b', 'workspace-a']),
    ).resolves.toEqual({ killsApplication: false })

    expect(events).toEqual([
      'database:workspace-b',
      'database:standardnotes',
      'database:workspace-a',
      'database:cached-workspace',
      'raw-storage',
      'keychain',
    ])
    expect(mockDatabaseDeleteAll).toHaveBeenCalledTimes(3)
    expect(keyValueStore.deleteAll).toHaveBeenCalledTimes(1)
    expect(rawValues).toEqual(new Map())
    expect(databases.size).toBe(0)
  })

  it('fails stopped before raw storage and keychain when a workspace database cannot be erased', async () => {
    const events: string[] = []
    const { clearRawKeychainValue, databases, device, keyValueStore } = createDevice(new Map(), events)
    mockDatabaseDeleteAll.mockImplementation(async (identifier: string) => {
      events.push(`database:${identifier}`)
      if (identifier === 'standardnotes') {
        throw new Error('metadata erase failed')
      }
    })

    await expect(device.clearAllDataFromDevice(['workspace-a', 'standardnotes', 'workspace-b'])).rejects.toThrow(
      'metadata erase failed',
    )

    expect(events).toEqual(['database:workspace-a', 'database:standardnotes'])
    expect(keyValueStore.deleteAll).not.toHaveBeenCalled()
    expect(clearRawKeychainValue).not.toHaveBeenCalled()
    expect(Array.from(databases.keys())).toEqual(['standardnotes'])
  })

  it('does not clear keychain material when the global raw-storage erase fails', async () => {
    const { clearRawKeychainValue, device, keyValueStore } = createDevice()
    keyValueStore.deleteAll.mockRejectedValueOnce(new Error('raw storage erase failed'))

    await expect(device.clearAllDataFromDevice(['workspace-a'])).rejects.toThrow('raw storage erase failed')

    expect(mockDatabaseDeleteAll).toHaveBeenCalledWith('workspace-a')
    expect(clearRawKeychainValue).not.toHaveBeenCalled()
  })

  it('reports keychain failure only after database and raw storage erasure', async () => {
    const events: string[] = []
    const { clearRawKeychainValue, databases, device } = createDevice(
      new Map([['unknown-native-row', 'value']]),
      events,
    )
    mockDatabaseDeleteAll.mockImplementation(async (identifier: string) => {
      events.push(`database:${identifier}`)
    })
    clearRawKeychainValue.mockImplementationOnce(async () => {
      events.push('keychain')
      throw new Error('keychain erase failed')
    })

    await expect(device.clearAllDataFromDevice(['standardnotes'])).rejects.toThrow('keychain erase failed')

    expect(events).toEqual(['database:standardnotes', 'raw-storage', 'keychain'])
    expect(databases.size).toBe(0)
  })

  it('hard reset requests a WebView recreation without clearing storage', async () => {
    const { clearRawKeychainValue, device, keyValueStore } = createDevice(new Map([['preserved', 'value']]))
    const receiver = jest.fn()
    const clearAllData = jest.spyOn(device, 'clearAllDataFromDevice')
    device.addMobileDeviceEventReceiver(receiver)

    await device.performHardReset()

    expect(receiver).toHaveBeenCalledTimes(1)
    expect(receiver).toHaveBeenCalledWith(MobileDeviceEvent.RequestsWebViewReload)
    expect(clearAllData).not.toHaveBeenCalled()
    expect(keyValueStore.deleteAll).not.toHaveBeenCalled()
    expect(mockDatabaseDeleteAll).not.toHaveBeenCalled()
    expect(clearRawKeychainValue).not.toHaveBeenCalled()
  })
})
