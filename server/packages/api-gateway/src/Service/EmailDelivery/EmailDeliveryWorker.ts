import { EmailDeliveryService } from './EmailDeliveryService'

export interface EmailDeliveryWorkerLogger {
  info(message: string, metadata?: Record<string, unknown>): void
  error(message: string, metadata?: Record<string, unknown>): void
}

export interface EmailDeliveryWorkerOptions {
  intervalMs?: number
  batchSize?: number
}

export class EmailDeliveryWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number
  private readonly batchSize: number

  constructor(
    private readonly service: EmailDeliveryService,
    private readonly logger?: EmailDeliveryWorkerLogger,
    options: EmailDeliveryWorkerOptions = {},
  ) {
    this.intervalMs = bounded(options.intervalMs, 5_000, 250, 60 * 60 * 1_000)
    this.batchSize = bounded(options.batchSize, 25, 1, 500)
  }

  start(): boolean {
    if (this.timer) {
      return false
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    return true
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    const counts: Record<string, number> = {}
    try {
      for (let index = 0; index < this.batchSize; index++) {
        const result = await this.service.processOne()
        counts[result.status] = (counts[result.status] ?? 0) + 1
        if (result.status === 'idle') {
          break
        }
      }
      const processed = Object.entries(counts).reduce(
        (total, [status, count]) => (status === 'idle' ? total : total + count),
        0,
      )
      if (processed > 0) {
        this.logger?.info('Email delivery worker batch completed.', { processed, outcomes: counts })
      }
    } catch (error) {
      this.logger?.error('Email delivery worker batch failed.', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
    } finally {
      this.running = false
    }
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Email delivery worker options are invalid.')
  }
  return value
}
