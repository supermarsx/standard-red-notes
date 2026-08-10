import { TimerInterface } from '@standardnotes/time'

import { ValetTokenRepositoryInterface } from '../../Domain/ValetToken/ValetTokenRepositoryInterface'

/**
 * Single-process replay protection for the zero-Redis home-server profile.
 *
 * The Redis implementation keeps a used valet token for one day. Preserve that
 * exact contract here while keeping the state process-local, which is safe for
 * the home-server topology because every files request is handled by the same
 * process.
 */
export class InMemoryValetTokenRepository implements ValetTokenRepositoryInterface {
  private readonly usedUntil = new Map<string, number>()
  private readonly valetTokenTTL = 60 * 60 * 24
  private readonly sweepInterval = 60
  private nextSweepAt = 0

  constructor(private timer: TimerInterface) {}

  async markAsUsed(valetToken: string): Promise<void> {
    const now = this.timer.getTimestampInSeconds()
    this.sweepExpired(now)
    this.usedUntil.set(valetToken, now + this.valetTokenTTL)
  }

  async isUsed(valetToken: string): Promise<boolean> {
    const now = this.timer.getTimestampInSeconds()
    this.sweepExpired(now)
    const expiresAt = this.usedUntil.get(valetToken)
    if (expiresAt === undefined) {
      return false
    }
    if (expiresAt <= now) {
      this.usedUntil.delete(valetToken)

      return false
    }

    return true
  }

  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) {
      return
    }
    for (const [token, expiresAt] of this.usedUntil) {
      if (expiresAt <= now) {
        this.usedUntil.delete(token)
      }
    }
    this.nextSweepAt = now + this.sweepInterval
  }
}
