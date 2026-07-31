import * as http from 'http'

export interface HomeServerRuntimeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface HomeServerRuntimeScheduler {
  stop(): void
}

export interface HomeServerRuntimeBridge {
  close(): Promise<void>
}

export interface HomeServerSignalTarget {
  on(event: 'SIGTERM', listener: () => void): unknown
  removeListener(event: 'SIGTERM', listener: () => void): unknown
}

export interface HomeServerRuntimeStartOptions {
  server: http.Server
  bridge: HomeServerRuntimeBridge
  logger: HomeServerRuntimeLogger
  startScheduler: () => HomeServerRuntimeScheduler
  onSigterm: () => Promise<void>
}

/**
 * Owns the resources whose lifetime must exactly match a running HomeServer.
 *
 * The large HomeServer bootstrap builds the application; this class keeps the
 * subtle readiness, signal, and teardown state small enough to test directly.
 */
export class HomeServerRuntime {
  private server: http.Server | undefined
  private scheduler: HomeServerRuntimeScheduler | undefined
  private bridge: HomeServerRuntimeBridge | undefined
  private logger: HomeServerRuntimeLogger | undefined
  private signalHandler: (() => void) | undefined
  private starting = false
  private stopPromise: Promise<void> | undefined

  constructor(
    private readonly signalTarget: HomeServerSignalTarget = process,
    private readonly closeTimeoutMs = 5_000,
  ) {}

  isActive(): boolean {
    return this.starting || this.server !== undefined || this.stopPromise !== undefined
  }

  isRunning(): boolean {
    return this.server?.listening === true
  }

  async start(options: HomeServerRuntimeStartOptions): Promise<void> {
    if (this.isActive()) {
      throw new Error('Home server is already running or changing state')
    }

    this.starting = true
    let resourcesAdopted = false
    try {
      await this.waitUntilListening(options.server)

      this.server = options.server
      this.bridge = options.bridge
      this.logger = options.logger
      resourcesAdopted = true
      this.scheduler = options.startScheduler()

      this.signalHandler = () => {
        void options.onSigterm().catch(() => {
          options.logger.error('Failed to stop home server after SIGTERM.')
        })
      }
      this.signalTarget.on('SIGTERM', this.signalHandler)
    } catch (error) {
      if (resourcesAdopted) {
        await this.stopResources().catch(() => undefined)
      } else {
        await options.bridge.close().catch(() => undefined)
        options.server.unref()
      }
      throw error
    } finally {
      this.starting = false
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    if (!this.server && !this.scheduler && !this.bridge) {
      return
    }

    this.stopPromise = this.stopResources()
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = undefined
    }
  }

  private async waitUntilListening(server: http.Server): Promise<void> {
    if (server.listening) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        server.removeListener('listening', onListening)
        server.removeListener('error', onError)
      }

      server.once('listening', onListening)
      server.once('error', onError)
    })
  }

  private async stopResources(): Promise<void> {
    const server = this.server
    const scheduler = this.scheduler
    const bridge = this.bridge
    const logger = this.logger

    if (this.signalHandler) {
      this.signalTarget.removeListener('SIGTERM', this.signalHandler)
      this.signalHandler = undefined
    }

    this.server = undefined
    this.scheduler = undefined
    this.bridge = undefined
    this.logger = undefined

    const errors: Error[] = []
    try {
      scheduler?.stop()
    } catch (error) {
      errors.push(error as Error)
    }

    const shutdowns: Promise<void>[] = []
    if (server) {
      shutdowns.push(this.closeServer(server, logger))
    }
    if (bridge) {
      shutdowns.push(bridge.close())
    }

    const results = await Promise.allSettled(shutdowns)
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)))
      }
    }

    if (errors.length > 0) {
      throw errors[0]
    }
  }

  private async closeServer(server: http.Server, logger: HomeServerRuntimeLogger | undefined): Promise<void> {
    if (!server.listening) {
      server.unref()
      return
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(forceCloseTimer)
        server.unref()
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      const forceCloseTimer = setTimeout(() => {
        logger?.warn(`Home server HTTP close exceeded ${this.closeTimeoutMs}ms; closing active connections`)
        server.closeAllConnections?.()
        finish()
      }, this.closeTimeoutMs)
      forceCloseTimer.unref()

      try {
        server.close(finish)
      } catch (error) {
        finish(error as Error)
      }
    })
  }
}
