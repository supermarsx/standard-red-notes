import { ShareRepositoryInterface } from '../Domain/Share/ShareRepositoryInterface'

export class ShareExpiryCleanup {
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>

  constructor(
    private repository: ShareRepositoryInterface,
    private onError: () => void,
    private intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) {
      return
    }
    const scan = () => void this.run().catch(this.onError)
    scan()
    this.timer = setInterval(scan, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  run(now = new Date()): Promise<void> {
    if (!this.pending) {
      this.pending = this.repository.revokeExpiredAndErasePayloads(now).finally(() => {
        this.pending = undefined
      })
    }
    return this.pending
  }
}
