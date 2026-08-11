import * as winston from 'winston'

jest.mock('@standardnotes/auth-server', () => ({
  Service: jest.fn(),
}))

import * as http from 'http'

import { buildHomeServerEnvironmentOverrides, HomeServer, HomeServerListener, listenHomeServer } from './HomeServer'

describe('listenHomeServer', () => {
  it('passes an explicit bind address to the HTTP listener', () => {
    const expectedServer = {} as http.Server
    const listen = jest.fn().mockReturnValue(expectedServer)

    const server = listenHomeServer({ listen } as unknown as HomeServerListener, 3000, '127.0.0.1')

    expect(server).toBe(expectedServer)
    expect(listen).toHaveBeenCalledWith(3000, '127.0.0.1')
  })

  it('preserves the existing unspecified-interface default when no bind address is configured', () => {
    const expectedServer = {} as http.Server
    const listen = jest.fn().mockReturnValue(expectedServer)

    const server = listenHomeServer({ listen } as unknown as HomeServerListener, 3000)

    expect(server).toBe(expectedServer)
    expect(listen).toHaveBeenCalledWith(3000)
  })
})

describe('HomeServer teardown', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('clears local resources even when runtime teardown reports an error', async () => {
    const server = new HomeServer() as unknown as {
      authService: unknown
      logStream: { end: jest.Mock } | undefined
      runtimeLogLevelApplier: { stop: jest.Mock } | undefined
      runtime: { isActive(): boolean; stop(): Promise<void> }
      stop(): ReturnType<HomeServer['stop']>
    }
    const end = jest.fn()
    const stopRuntimeLogLevelApplier = jest.fn()
    const closeLogger = jest.spyOn(winston.loggers, 'close').mockImplementation(() => undefined)
    server.authService = {}
    server.logStream = { end }
    server.runtimeLogLevelApplier = { stop: stopRuntimeLogLevelApplier }
    server.runtime = {
      isActive: () => true,
      stop: jest.fn().mockRejectedValue(new Error('bridge close failed')),
    }

    const result = await server.stop()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('bridge close failed')
    expect(closeLogger).toHaveBeenCalledTimes(6)
    expect(stopRuntimeLogLevelApplier).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(server.authService).toBeUndefined()
    expect(server.logStream).toBeUndefined()
    expect(server.runtimeLogLevelApplier).toBeUndefined()
  })

  it('continues closing every local resource when one logger close fails', async () => {
    const server = new HomeServer() as unknown as {
      authService: unknown
      logStream: { end: jest.Mock } | undefined
      runtime: { isActive(): boolean; stop(): Promise<void> }
      stop(): ReturnType<HomeServer['stop']>
    }
    const end = jest.fn()
    const closeLogger = jest
      .spyOn(winston.loggers, 'close')
      .mockImplementationOnce(() => {
        throw new Error('logger close failed')
      })
      .mockImplementation(() => undefined)
    server.authService = {}
    server.logStream = { end }
    server.runtime = {
      isActive: () => true,
      stop: jest.fn().mockResolvedValue(undefined),
    }

    const result = await server.stop()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('logger close failed')
    expect(closeLogger).toHaveBeenCalledTimes(6)
    expect(end).toHaveBeenCalledTimes(1)
    expect(server.authService).toBeUndefined()
    expect(server.logStream).toBeUndefined()
  })

  it('does not activate premium features after the HTTP listener stops unexpectedly', async () => {
    const server = new HomeServer() as unknown as {
      authService: { activatePremiumFeatures: jest.Mock } | undefined
      runtime: { isRunning(): boolean }
      activatePremiumFeatures: HomeServer['activatePremiumFeatures']
    }
    const activatePremiumFeatures = jest.fn()
    server.authService = { activatePremiumFeatures }
    server.runtime = { isRunning: () => false }

    const result = await server.activatePremiumFeatures({
      username: 'user@example.test',
      subscriptionId: 42,
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Home server is not running.')
    expect(activatePremiumFeatures).not.toHaveBeenCalled()
  })
})

describe('buildHomeServerEnvironmentOverrides', () => {
  it('defaults the shared admin overlay inside the configured data directory', () => {
    const environment = buildHomeServerEnvironmentOverrides('/srv/notes', undefined)

    expect(environment.SERVER_SETTINGS_PATH).toBe('/srv/notes/server-settings.json')
  })

  it('preserves an explicit shared admin overlay path', () => {
    const environment = buildHomeServerEnvironmentOverrides('/srv/notes', {
      SERVER_SETTINGS_PATH: '/mnt/runtime/server-settings.json',
    })

    expect(environment.SERVER_SETTINGS_PATH).toBe('/mnt/runtime/server-settings.json')
  })

  it('defaults current Standard Red Notes clients to password and TOTP capable v3 tokens', () => {
    const environment = buildHomeServerEnvironmentOverrides('data', undefined)

    expect(environment.APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2).toBe('0.0.0')
    expect(environment.APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3).toBe('0.0.0')
  })

  it('allows an operator to stage a deliberate client-version rollout', () => {
    const environment = buildHomeServerEnvironmentOverrides('data', {
      APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2: '3.20.0',
      APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3: '3.30.0',
    })

    expect(environment.APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2).toBe('3.20.0')
    expect(environment.APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3).toBe('3.30.0')
  })

  it('preserves deployment identity for aggregate readiness', () => {
    const environment = buildHomeServerEnvironmentOverrides('data', {
      SRN_DEPLOY_REVISION: '0123456789abcdef0123456789abcdef01234567',
      SRN_DEPLOY_VERSION: 'v26.8.11',
    })

    expect(environment.SRN_DEPLOY_REVISION).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(environment.SRN_DEPLOY_VERSION).toBe('v26.8.11')
  })
})
