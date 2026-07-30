import * as winston from 'winston'

jest.mock('@standardnotes/auth-server', () => ({
  Service: jest.fn(),
}))

import { HomeServer } from './HomeServer'

describe('HomeServer teardown', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('clears local resources even when runtime teardown reports an error', async () => {
    const server = new HomeServer() as unknown as {
      authService: unknown
      logStream: { end: jest.Mock } | undefined
      runtime: { isActive(): boolean; stop(): Promise<void> }
      stop(): ReturnType<HomeServer['stop']>
    }
    const end = jest.fn()
    const closeLogger = jest.spyOn(winston.loggers, 'close').mockImplementation(() => undefined)
    server.authService = {}
    server.logStream = { end }
    server.runtime = {
      isActive: () => true,
      stop: jest.fn().mockRejectedValue(new Error('bridge close failed')),
    }

    const result = await server.stop()

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('bridge close failed')
    expect(closeLogger).toHaveBeenCalledTimes(6)
    expect(end).toHaveBeenCalledTimes(1)
    expect(server.authService).toBeUndefined()
    expect(server.logStream).toBeUndefined()
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
