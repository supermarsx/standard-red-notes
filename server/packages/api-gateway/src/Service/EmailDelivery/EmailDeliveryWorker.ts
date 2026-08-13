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
  private inFlight: Promise<void> | null = null
  private stopping = false
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
    if (this.timer || this.stopping) {
      return false
    }
    this.stopping = false
    this.service.endDrain()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    return true
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.service.beginDrain()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      await this.inFlight
    } finally {
      this.stopping = false
    }
  }

  tick(): Promise<void> {
    if (this.inFlight || this.stopping) {
      return this.inFlight ?? Promise.resolve()
    }
    const operation = this.runBatch()
    const tracked = operation.finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = null
      }
    })
    this.inFlight = tracked
    return tracked
  }

  private async runBatch(): Promise<void> {
    const counts: Record<string, number> = {}
    try {
      for (let index = 0; index < this.batchSize; index++) {
        if (this.stopping) {
          break
        }
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
