import { ReminderDeliveryService } from './ReminderDeliveryService'

/**
 * Standard Red Notes: in-process scheduler that periodically delivers due
 * reminders.
 *
 * The home-server has no existing cron/scheduler of its own, so this first slice
 * uses a simple `setInterval`. It is started by the home-server ONLY when the
 * feature env flag is on; `start()` is a no-op when the service is disabled, so
 * mounting it is always safe.
 *
 * Each tick is fully guarded: a thrown error or rejected promise inside a tick is
 * caught and (optionally) logged, never crashing the timer or the process. Ticks
 * do not overlap — a slow scan defers the next tick rather than running two at
 * once.
 *
 * PUNCH-LIST: a single-node interval is fine for one home-server instance but is
 * NOT cluster-safe (two instances would double-send). Durable/clustered
 * scheduling is deferred.
 */

export interface SchedulerLogger {
  info(message: string): void
  error(message: string): void
}

export class ReminderDeliveryScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly service: ReminderDeliveryService,
    private readonly intervalMs: number,
    private readonly logger?: SchedulerLogger,
  ) {}

  /** Start the interval. No-op when the feature is disabled or already started. */
  start(): boolean {
    if (!this.service.isEnabled()) {
      return false
    }
    if (this.timer) {
      return true
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // Don't keep the event loop alive solely for this timer.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
    this.logger?.info(`Reminder delivery scheduler started (every ${Math.round(this.intervalMs / 1000)}s).`)
    return true
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run one scan now. Exposed for tests and for an optional immediate first run. */
  async tick(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      const summary = await this.service.deliverDueReminders()
      if (summary.sent > 0 || summary.failed > 0) {
        this.logger?.info(
          `Reminder delivery: ${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} skipped ` +
            `(of ${summary.due} due / ${summary.scanned} unsent).`,
        )
      }
    } catch (error) {
      this.logger?.error(`Reminder delivery tick failed: ${(error as Error).message}`)
    } finally {
      this.running = false
    }
  }
}
