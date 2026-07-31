import { AppGroupManagedApplication, DeinitMode, DeinitSource, DeviceInterface } from '@standardnotes/services'
import { Environment } from '@standardnotes/models'
import { ApplicationGroupEvent } from './ApplicationGroupEvent'
import { SNApplicationGroup } from './ApplicationGroup'

const createDescriptorRecord = () => ({
  workspace: {
    identifier: 'workspace',
    label: 'Main Workspace',
    primary: true,
  },
})

function createApplication(): AppGroupManagedApplication {
  return {
    identifier: 'workspace',
    addEventObserver: jest.fn(() => jest.fn()),
    setOnDeinit: jest.fn(),
  } as unknown as AppGroupManagedApplication
}

function createDevice(lifecycle: string[], descriptors = createDescriptorRecord()): DeviceInterface {
  return {
    environment: Environment.Web,
    isDeviceDestroyed: jest.fn(() => false),
    getJsonParsedRawStorageValue: jest.fn(async () => descriptors),
    setRawStorageValue: jest.fn(async () => undefined),
    clearAllDataFromDevice: jest.fn(async () => {
      lifecycle.push('clear-all-data')
      return { killsApplication: false }
    }),
    deinit: jest.fn(() => lifecycle.push('device-deinit')),
    performHardReset: jest.fn(async () => {
      lifecycle.push('hard-reset')
    }),
    performSoftReset: jest.fn(async () => {
      lifecycle.push('soft-reset')
    }),
  } as unknown as DeviceInterface
}

describe('SNApplicationGroup runtime resets', () => {
  /**
   * Application.deinit invokes its DeinitCallback fire-and-forget. These tests
   * await onApplicationDeinit directly only to verify its internal sequencing;
   * callers of Application.lock must not assume that the reload has completed.
   */
  it.each([DeinitSource.Lock, DeinitSource.SwitchWorkspace])(
    'performs a hard runtime reset without clearing data for source %s',
    async (source) => {
      const lifecycle: string[] = []
      const device = createDevice(lifecycle)
      const application = createApplication()
      const group = new SNApplicationGroup(device)

      await group.initialize({ applicationCreator: async () => application })
      group.addEventObserver((event) => {
        if (event === ApplicationGroupEvent.DeviceWillRestart) {
          lifecycle.push('device-will-restart')
        }
      })

      await group.onApplicationDeinit(application, DeinitMode.Hard, source)

      expect(device.clearAllDataFromDevice).not.toHaveBeenCalled()
      expect(device.performSoftReset).not.toHaveBeenCalled()
      expect(device.performHardReset).toHaveBeenCalledTimes(1)
      expect(lifecycle).toEqual(['device-will-restart', 'device-deinit', 'hard-reset'])
    },
  )

  it('does not let a rejecting restart observer prevent the fire-and-forget hard reset', async () => {
    const lifecycle: string[] = []
    const device = createDevice(lifecycle)
    const application = createApplication()
    const group = new SNApplicationGroup(device)
    const consoleError = jest.spyOn(console, 'error').mockImplementation()

    try {
      await group.initialize({ applicationCreator: async () => application })
      group.addEventObserver(async (event) => {
        if (event === ApplicationGroupEvent.DeviceWillRestart) {
          throw new Error('observer failed')
        }
      })

      await group.onApplicationDeinit(application, DeinitMode.Hard, DeinitSource.Lock)
      await Promise.resolve()

      expect(device.performHardReset).toHaveBeenCalledTimes(1)
      expect(lifecycle).toEqual(['device-deinit', 'hard-reset'])
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to notify observers before device reset.',
        expect.objectContaining({ message: 'observer failed' }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('continues resetting when descriptor persistence fails during sign out', async () => {
    const lifecycle: string[] = []
    const descriptors = {
      ...createDescriptorRecord(),
      secondary: {
        identifier: 'secondary',
        label: 'Secondary Workspace',
        primary: false,
      },
    }
    const device = createDevice(lifecycle, descriptors)
    const application = createApplication()
    const group = new SNApplicationGroup(device)
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    jest.mocked(device.setRawStorageValue).mockRejectedValue(new Error('storage unavailable'))

    try {
      await group.initialize({ applicationCreator: async () => application })
      await group.onApplicationDeinit(application, DeinitMode.Hard, DeinitSource.SignOut)

      expect(device.clearAllDataFromDevice).not.toHaveBeenCalled()
      expect(device.performHardReset).toHaveBeenCalledTimes(1)
      expect(lifecycle).toEqual(['device-deinit', 'hard-reset'])
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to persist descriptor removal before device reset.',
        expect.objectContaining({ message: 'storage unavailable' }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('fails stopped instead of soft-reloading stale credentials when clear-all fails', async () => {
    const lifecycle: string[] = []
    const device = createDevice(lifecycle)
    const application = createApplication()
    const group = new SNApplicationGroup(device)
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    jest.mocked(device.clearAllDataFromDevice).mockRejectedValue(new Error('disk clear failed'))

    try {
      await group.initialize({ applicationCreator: async () => application })
      await group.onApplicationDeinit(application, DeinitMode.Soft, DeinitSource.SignOutAll)

      expect(device.clearAllDataFromDevice).toHaveBeenCalledWith(['workspace'])
      expect(device.performSoftReset).not.toHaveBeenCalled()
      expect(device.performHardReset).not.toHaveBeenCalled()
      expect(device.deinit).not.toHaveBeenCalled()
      expect(lifecycle).toEqual([])
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to clear all device data before reset.',
        expect.objectContaining({ message: 'disk clear failed' }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
