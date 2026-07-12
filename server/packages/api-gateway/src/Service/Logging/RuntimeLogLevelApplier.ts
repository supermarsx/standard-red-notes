import { LOG_LEVELS } from '../ServerSettings/ServerSettingsResolver'

/**
 * Standard Red Notes: RUNTIME LOG VERBOSITY applier (api-gateway).
 *
 * winston log levels are mutable at runtime and the gateway logger is a shared
 * singleton, so an admin can change how verbose the SERVER writes WITHOUT a
 * restart. This poller re-reads the effective `logging.level` from the persisted
 * server-settings overlay (via the resolver) once at boot and then on an interval
 * (default 30s), mutating the live logger's `level` and each transport's `level`.
 *
 * SCOPE HONESTY: in the single-container image every service shares
 * SERVER_SETTINGS_PATH, so one `logging.level` applies to every service that runs
 * such a poller (phase 1: api-gateway + auth). Sibling services without a poller
 * keep honoring their LOG_LEVEL env until a follow-up adds theirs. In a
 * multi-service topology without a shared volume, the control only affects
 * services that can read the overlay.
 *
 * FAIL-OPEN + STARTUP SAFETY (memory: "verify container boot"): every tick is
 * fully guarded — a rejected resolve or a bad value is swallowed, never crashing
 * the timer or the process. `start()` is called during Container bootstrap and
 * MUST NOT throw. The interval is `unref()`'d so it never keeps the event loop
 * alive on its own.
 */

/**
 * The minimal mutable-level shape a winston Logger structurally satisfies. Kept
 * narrow so the applier is unit-testable with a plain stub.
 */
export interface MutableLevelLogger {
  level: string
  transports: Array<{ level?: string }>
}

export class RuntimeLogLevelApplier {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly logger: MutableLevelLogger,
    private readonly resolveLevel: () => Promise<string>,
    private readonly intervalMs: number = 30_000,
  ) {}

  /**
   * Apply the effective level once immediately, then start the poll interval.
   * No-op when already started. Never throws — safe to call at bootstrap.
   */
  start(): void {
    if (this.timer) {
      return
    }
    void this.applyOnce()
    this.timer = setInterval(() => {
      void this.applyOnce()
    }, this.intervalMs)
    // Don't keep the event loop alive solely for this poller.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  /** Stop the poll interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Read the effective level and apply it to the logger + every transport. Guards
   * against a rejected resolve and an invalid level (a value outside the winston
   * set is ignored rather than corrupting the logger). Fully swallows errors.
   */
  async applyOnce(): Promise<void> {
    try {
      const level = await this.resolveLevel()
      if (!LOG_LEVELS.includes(level)) {
        return
      }
      if (this.logger.level !== level) {
        this.logger.level = level
      }
      for (const transport of this.logger.transports ?? []) {
        if (transport && transport.level !== level) {
          transport.level = level
        }
      }
    } catch {
      // Never let a poller tick crash the process.
    }
  }
}
