import { SyncCommandOutboxRepositoryInterface } from './SyncCommandOutboxRepositoryInterface'
import { SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Logger } from 'winston'

export class CleanupSyncCommands {
  private interval?: NodeJS.Timeout
  private activeCleanup?: Promise<{ commands: number; outboxEvents: number }>

  constructor(
    private readonly commandRepository: SyncCommandRepositoryInterface,
    private readonly outboxRepository: SyncCommandOutboxRepositoryInterface,
    private readonly publishedOutboxRetentionMilliseconds: number,
    private readonly logger?: Logger,
  ) {}

  execute(now = Date.now()): Promise<{ commands: number; outboxEvents: number }> {
    if (this.activeCleanup) {
      return Promise.resolve({ commands: 0, outboxEvents: 0 })
    }

    const cleanup = this.performCleanup(now)
    this.activeCleanup = cleanup
    const clearActiveCleanup = (): void => {
      if (this.activeCleanup === cleanup) {
        this.activeCleanup = undefined
      }
    }
    void cleanup.then(clearActiveCleanup, clearActiveCleanup)

    return cleanup
  }

  async waitForIdle(): Promise<void> {
    await this.activeCleanup
  }

  private async performCleanup(now: number): Promise<{ commands: number; outboxEvents: number }> {
    const commands = await this.commandRepository.deleteExpired(now)
    const outboxEvents = await this.outboxRepository.deletePublishedBefore(
      now - this.publishedOutboxRetentionMilliseconds,
    )

    return { commands, outboxEvents }
  }

  wake(): void {
    void this.execute().catch((error) => {
      this.logger?.error('Sync command cleanup background run failed.', {
        ...safeErrorLogMetadata(error),
        codeTag: 'CleanupSyncCommands',
      })
    })
  }

  start(intervalMilliseconds: number): void {
    if (this.interval) {
      return
    }
    this.interval = setInterval(() => this.wake(), intervalMilliseconds)
    this.interval.unref()
    this.wake()
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }
}
