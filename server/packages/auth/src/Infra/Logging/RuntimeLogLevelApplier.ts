import { Logger } from 'winston'

/**
 * Standard Red Notes: applies the admin-set runtime LOG VERBOSITY to the winston
 * logger without a restart. winston levels (both `logger.level` and each
 * transport's `level`) are mutable at runtime, and auth already reads the shared
 * ServerSettings overlay file the gateway admin surface writes.
 *
 * On start it applies the resolved level once, then re-reads on an interval
 * (default 30s) so an admin change lands within one poll. Precedence, resolved
 * per poll: persisted `logging.level` (via the injected getter) > the boot-time
 * fallback (env LOG_LEVEL) > 'info'. An unknown/invalid level is ignored (the
 * previous valid level stays).
 *
 * DEFENSIVE BY DESIGN (memory: "verify container boot"): it MUST NOT throw during
 * bootstrap or on any poll — the getter is awaited inside a try/catch, the
 * interval is `unref`'d so it never keeps the process alive, and `start()`
 * swallows any synchronous error.
 */
export class RuntimeLogLevelApplier {
  static readonly VALID_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']

  private timer?: ReturnType<typeof setInterval>

  constructor(
    private logger: Logger,
    private levelGetter: () => Promise<string | undefined>,
    private fallbackLevel: string,
    private intervalMs: number = 30_000,
  ) {}

  /** Applies the level once immediately, then starts the poll. Never throws. */
  start(): void {
    try {
      void this.applyOnce()
      this.timer = setInterval(() => {
        void this.applyOnce()
      }, this.intervalMs)
      // Do not keep the process (or a test runner / CLI) alive on our account.
      if (typeof this.timer.unref === 'function') {
        this.timer.unref()
      }
    } catch {
      // Never let log-level polling break bootstrap.
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Reads the desired level and applies it. Swallows every error (fail-safe). */
  async applyOnce(): Promise<void> {
    try {
      const desired = this.normalize(await this.levelGetter())
      const level = desired ?? this.normalize(this.fallbackLevel) ?? 'info'
      this.setLevel(level)
    } catch {
      // Swallow — an unreadable overlay must never change or crash logging.
    }
  }

  private normalize(level: string | undefined): string | undefined {
    return typeof level === 'string' && RuntimeLogLevelApplier.VALID_LEVELS.includes(level) ? level : undefined
  }

  private setLevel(level: string): void {
    if (this.logger.level !== level) {
      this.logger.level = level
    }
    // A transport with its OWN level overrides logger.level for that transport,
    // so the console transport must be updated too or the change is invisible.
    for (const transport of this.logger.transports) {
      if (transport.level !== level) {
        transport.level = level
      }
    }
  }
}
