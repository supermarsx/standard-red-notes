import { EventEmitter } from 'events'
import * as http from 'http'

import { HomeServerRuntime, HomeServerSignalTarget } from './HomeServerRuntime'

class FakeServer extends EventEmitter {
  listening = false
  close = jest.fn<(callback: (error?: Error) => void) => void>()
  closeAllConnections = jest.fn()
  unref = jest.fn()
}

class FakeSignalTarget implements HomeServerSignalTarget {
  readonly listeners = new Set<() => void>()

  on(_event: 'SIGTERM', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeListener(_event: 'SIGTERM', listener: () => void): void {
    this.listeners.delete(listener)
  }

  emitSigterm(): void {
    for (const listener of [...this.listeners]) {
      listener()
    }
  }
}

describe('HomeServerRuntime', () => {
  let signalTarget: FakeSignalTarget
  let scheduler: { stop: jest.Mock }
  let bridge: { close: jest.Mock }
  let logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock }
  let onSigterm: jest.Mock
  let ready: boolean
  let readinessState: { markReady: jest.Mock; markUnavailable: jest.Mock }

  const start = (runtime: HomeServerRuntime, server: FakeServer) =>
    runtime.start({
      server: server as unknown as http.Server,
      bridge,
      logger,
      readinessState,
      startScheduler: () => scheduler,
      onSigterm,
    })

  beforeEach(() => {
    signalTarget = new FakeSignalTarget()
    scheduler = { stop: jest.fn() }
    bridge = { close: jest.fn().mockResolvedValue(undefined) }
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    onSigterm = jest.fn().mockResolvedValue(undefined)
    ready = false
    readinessState = {
      markReady: jest.fn(() => {
        ready = true
      }),
      markUnavailable: jest.fn(() => {
        ready = false
      }),
    }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does not report readiness or start background work before the HTTP server listens', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    const startPromise = start(runtime, server)

    expect(runtime.isRunning()).toBe(false)
    expect(ready).toBe(false)
    expect(readinessState.markReady).not.toHaveBeenCalled()
    expect(signalTarget.listeners.size).toBe(0)

    server.listening = true
    server.emit('listening')
    await startPromise

    expect(runtime.isRunning()).toBe(true)
    expect(ready).toBe(true)
    expect(readinessState.markReady).toHaveBeenCalledTimes(1)
    expect(signalTarget.listeners.size).toBe(1)
  })

  it('rejects a second start while resources are active', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())

    await start(runtime, server)

    await expect(start(runtime, server)).rejects.toThrow('Home server is already running or changing state')

    await runtime.stop()
  })

  it('rejects a listen error and closes the already-created bridge', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    bridge.close.mockRejectedValue(new Error('bridge cleanup failed'))
    const startPromise = start(runtime, server)

    server.emit('error', new Error('address in use'))

    await expect(startPromise).rejects.toThrow('address in use')
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(server.unref).toHaveBeenCalledTimes(1)
    expect(runtime.isActive()).toBe(false)
  })

  it('logs a rejected SIGTERM shutdown without creating an unhandled rejection', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())
    onSigterm.mockRejectedValue(new Error('shutdown failed'))

    await start(runtime, server)
    signalTarget.emitSigterm()
    await Promise.resolve()
    await Promise.resolve()

    expect(logger.error).toHaveBeenCalledWith('Failed to stop home server after SIGTERM.')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('shutdown failed')

    await runtime.stop()
  })

  it('fails startup and tears down adopted resources when the scheduler cannot start', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())
    bridge.close.mockRejectedValue(new Error('bridge cleanup failed'))

    await expect(
      runtime.start({
        server: server as unknown as http.Server,
        bridge,
        logger,
        readinessState,
        startScheduler: () => {
          throw new Error('scheduler unavailable')
        },
        onSigterm,
      }),
    ).rejects.toThrow('scheduler unavailable')

    expect(server.close).toHaveBeenCalledTimes(1)
    expect(server.unref).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(signalTarget.listeners.size).toBe(0)
    expect(runtime.isActive()).toBe(false)
    expect(ready).toBe(false)
    expect(readinessState.markReady).not.toHaveBeenCalled()
  })

  it('awaits HTTP close and stops each owned resource once across concurrent stop calls', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    let finishClose!: () => void
    server.close.mockImplementation((callback) => {
      finishClose = callback
    })

    await start(runtime, server)
    const firstStop = runtime.stop()
    const secondStop = runtime.stop()
    let stopped = false
    void firstStop.then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    expect(readinessState.markUnavailable).toHaveBeenCalled()
    expect(stopped).toBe(false)
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(scheduler.stop).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)

    finishClose()
    await Promise.all([firstStop, secondStop])

    expect(stopped).toBe(true)
    expect(signalTarget.listeners.size).toBe(0)
    expect(runtime.isActive()).toBe(false)
  })

  it('treats stopping an inactive runtime as a no-op', async () => {
    const runtime = new HomeServerRuntime(signalTarget)

    await expect(runtime.stop()).resolves.toBeUndefined()

    expect(scheduler.stop).not.toHaveBeenCalled()
    expect(bridge.close).not.toHaveBeenCalled()
  })

  it('still closes the server and bridge when scheduler shutdown throws', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())
    scheduler.stop.mockImplementation(() => {
      throw new Error('scheduler stop failed')
    })

    await start(runtime, server)

    await expect(runtime.stop()).rejects.toThrow('scheduler stop failed')
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(runtime.isActive()).toBe(false)
  })

  it('still tears down every resource when closing the readiness gate throws', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())

    await start(runtime, server)
    readinessState.markUnavailable.mockImplementation(() => {
      throw new Error('readiness close failed')
    })

    await expect(runtime.stop()).rejects.toThrow('readiness close failed')
    expect(scheduler.stop).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(runtime.isActive()).toBe(false)
  })

  it('normalizes non-Error resource shutdown rejections', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback())
    bridge.close.mockRejectedValue('bridge stop failed')

    await start(runtime, server)

    await expect(runtime.stop()).rejects.toThrow('bridge stop failed')
    expect(runtime.isActive()).toBe(false)
  })

  it('propagates an HTTP close callback error after closing the bridge', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => callback(new Error('http close failed')))

    await start(runtime, server)

    await expect(runtime.stop()).rejects.toThrow('http close failed')
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('propagates a synchronous HTTP close failure', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation(() => {
      throw new Error('close threw')
    })

    await start(runtime, server)

    await expect(runtime.stop()).rejects.toThrow('close threw')
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate close callback after shutdown has settled', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation((callback) => {
      callback()
      callback(new Error('late close error'))
    })

    await start(runtime, server)

    await expect(runtime.stop()).resolves.toBeUndefined()
    expect(server.unref).toHaveBeenCalledTimes(1)
  })

  it('unrefs an HTTP server that stopped listening before teardown', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const server = new FakeServer()
    server.listening = true

    await start(runtime, server)
    server.listening = false
    await runtime.stop()

    expect(server.close).not.toHaveBeenCalled()
    expect(server.unref).toHaveBeenCalledTimes(1)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung HTTP close, severs active connections, and removes SIGTERM', async () => {
    jest.useFakeTimers()
    const runtime = new HomeServerRuntime(signalTarget, 100)
    const server = new FakeServer()
    server.listening = true
    server.close.mockImplementation(() => undefined)

    await start(runtime, server)
    const stopPromise = runtime.stop()

    expect(signalTarget.listeners.size).toBe(0)
    expect(server.closeAllConnections).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(100)
    await stopPromise

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(server.unref).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Home server HTTP close exceeded 100ms; closing active connections')
    expect(runtime.isActive()).toBe(false)
  })

  it('removes the SIGTERM handler on stop and does not accumulate listeners after restart', async () => {
    const runtime = new HomeServerRuntime(signalTarget)
    const firstServer = new FakeServer()
    firstServer.listening = true
    firstServer.close.mockImplementation((callback) => callback())

    await start(runtime, firstServer)
    expect(signalTarget.listeners.size).toBe(1)
    await runtime.stop()
    expect(signalTarget.listeners.size).toBe(0)

    const secondServer = new FakeServer()
    secondServer.listening = true
    secondServer.close.mockImplementation((callback) => callback())
    await start(runtime, secondServer)

    expect(signalTarget.listeners.size).toBe(1)
    signalTarget.emitSigterm()
    expect(onSigterm).toHaveBeenCalledTimes(1)
  })
})
