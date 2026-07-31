import { constants, promises as fs } from 'node:fs'

const MAX_SERVER_SETTINGS_BYTES = 1024 * 1024

export const RUNTIME_LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const

export type RuntimeLogLevel = (typeof RUNTIME_LOG_LEVELS)[number]

export interface MutableRuntimeLogLevelLogger {
  level: string
  transports: Array<{ level?: string }>
}

export interface RuntimeLogLevelResolver {
  resolve(): Promise<string | undefined>
}

type ReadTextFile = (filePath: string) => Promise<string>

async function readBoundedServerSettingsFile(filePath: string): Promise<string> {
  const pathStats = await fs.lstat(filePath)
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > MAX_SERVER_SETTINGS_BYTES) {
    throw new Error('Runtime server settings must be a bounded regular file.')
  }

  const noFollow = constants.O_NOFOLLOW ?? 0
  const file = await fs.open(filePath, constants.O_RDONLY | noFollow)
  try {
    const fileStats = await file.stat()
    if (
      !fileStats.isFile() ||
      fileStats.size > MAX_SERVER_SETTINGS_BYTES ||
      fileStats.dev !== pathStats.dev ||
      fileStats.ino !== pathStats.ino
    ) {
      throw new Error('Runtime server settings changed while opening.')
    }

    const buffer = Buffer.alloc(fileStats.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > fileStats.size) {
      throw new Error('Runtime server settings changed while reading.')
    }

    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

/**
 * Normalizes the persisted/admin and environment contracts to a known Winston
 * level. Unknown values never reach a live logger.
 */
export function normalizeRuntimeLogLevel(value: unknown): RuntimeLogLevel | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  return RUNTIME_LOG_LEVELS.find((level) => level === normalized)
}

/**
 * Reads the gateway-owned server-settings overlay without taking a dependency
 * on the gateway package. Precedence is persisted `logging.level`, then the
 * process-specific environment baseline, then `info`.
 *
 * Missing, unreadable, malformed, and contract-invalid overlays all fall back
 * to the baseline. This keeps logging available and predictable even if an
 * operator edits or removes the JSON file while a service is running.
 */
export class ServerSettingsLogLevelResolver implements RuntimeLogLevelResolver {
  private readonly fallbackLevel: RuntimeLogLevel

  constructor(
    private readonly settingsPath: string | undefined,
    baselineLevel: string | undefined,
    private readonly readTextFile: ReadTextFile = readBoundedServerSettingsFile,
  ) {
    this.fallbackLevel = normalizeRuntimeLogLevel(baselineLevel) ?? 'info'
  }

  async resolve(): Promise<RuntimeLogLevel> {
    if (!this.settingsPath?.trim()) {
      return this.fallbackLevel
    }

    try {
      const overlay = JSON.parse(await this.readTextFile(this.settingsPath)) as unknown
      const persistedLevel = this.readPersistedLevel(overlay)
      return persistedLevel ?? this.fallbackLevel
    } catch {
      return this.fallbackLevel
    }
  }

  private readPersistedLevel(overlay: unknown): RuntimeLogLevel | undefined {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
      return undefined
    }

    const logging = (overlay as { logging?: unknown }).logging
    if (!logging || typeof logging !== 'object' || Array.isArray(logging)) {
      return undefined
    }

    return normalizeRuntimeLogLevel((logging as { level?: unknown }).level)
  }
}

/**
 * Applies one resolved level to one or more live Winston-compatible loggers.
 * Both the logger and every transport are updated because a transport-specific
 * level overrides the logger level. The poll is idempotent, unref'd, and fully
 * guarded so runtime configuration can never crash a server process.
 */
export class RuntimeLogLevelApplier {
  private timer: ReturnType<typeof setInterval> | undefined

  private started = false

  private generation = 0

  private applyInFlight: Promise<void> | undefined

  private rerunRequested = false

  private readonly loggers: MutableRuntimeLogLevelLogger[]

  constructor(
    loggerOrLoggers: MutableRuntimeLogLevelLogger | readonly MutableRuntimeLogLevelLogger[],
    private readonly resolver: RuntimeLogLevelResolver,
    private readonly intervalMs = 30_000,
  ) {
    const loggers = Array.isArray(loggerOrLoggers) ? loggerOrLoggers : [loggerOrLoggers]
    this.loggers = [...new Set(loggers)]
  }

  /** Apply immediately and then poll. Repeated calls do not create more timers. */
  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    const generation = ++this.generation
    try {
      void this.requestPoll(generation)
      this.timer = setInterval(() => {
        void this.requestPoll(generation)
      }, this.intervalMs)
      this.timer.unref?.()
    } catch {
      this.started = false
      this.generation += 1
      this.rerunRequested = false
      this.timer = undefined
    }
  }

  /** Stop polling. A stopped applier may be started again. */
  stop(): void {
    if (!this.started && this.timer === undefined) {
      return
    }

    this.started = false
    this.generation += 1
    this.rerunRequested = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
    }
    this.timer = undefined
  }

  /** Resolve and apply once. All read/resolver failures leave current levels intact. */
  async applyOnce(): Promise<void> {
    await this.resolveAndApply()
  }

  /**
   * Coalesce interval ticks while a read is slow. At most one read runs and one
   * follow-up is queued, so an unavailable filesystem cannot grow an unbounded
   * promise queue. The generation guard also makes a pre-stop result inert.
   */
  private requestPoll(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) {
      return Promise.resolve()
    }
    if (this.applyInFlight) {
      this.rerunRequested = true
      return this.applyInFlight
    }

    const poll = this.resolveAndApply(generation).finally(() => {
      this.applyInFlight = undefined
      if (this.rerunRequested && this.started) {
        this.rerunRequested = false
        void this.requestPoll(this.generation)
      }
    })
    this.applyInFlight = poll

    return poll
  }

  private async resolveAndApply(expectedGeneration?: number): Promise<void> {
    try {
      const level = normalizeRuntimeLogLevel(await this.resolver.resolve())
      if (!level) {
        return
      }
      if (expectedGeneration !== undefined && (!this.started || expectedGeneration !== this.generation)) {
        return
      }

      for (const logger of this.loggers) {
        logger.level = level
        for (const transport of logger.transports ?? []) {
          transport.level = level
        }
      }
    } catch {
      // Runtime logging controls must never take down the owning process.
    }
  }
}
