export interface InviteRealtimeSessionCoordinator {
  startSession(sessionScope: string): Promise<void>
  stopSession(): void
}

export type InviteRealtimeApplicationLifecycleOptions = {
  coordinator: InviteRealtimeSessionCoordinator
  isSignedIn(): boolean
  getSessionScope(): Promise<string | undefined>
}

/**
 * Binds the durable invite stream to exactly one authenticated application
 * session. Repeated launch/sign-in notifications for the same opaque scope are
 * coalesced; sign-out and socket revocation synchronously abort the coordinator.
 */
export class InviteRealtimeApplicationLifecycle {
  private generation = 0
  private activeScope?: string
  private startPromise?: Promise<void>

  constructor(private readonly options: InviteRealtimeApplicationLifecycleOptions) {}

  async startIfAuthenticated(): Promise<void> {
    const generation = ++this.generation
    if (!this.options.isSignedIn()) {
      this.stop()
      return
    }

    const sessionScope = await this.options.getSessionScope()
    if (generation !== this.generation) {
      return
    }
    if (!this.options.isSignedIn() || sessionScope === undefined) {
      this.stop()
      return
    }
    if (this.activeScope === sessionScope) {
      await this.startPromise
      return
    }

    this.activeScope = sessionScope
    const startPromise = this.options.coordinator.startSession(sessionScope)
    this.startPromise = startPromise
    try {
      await startPromise
    } catch (error) {
      if (this.activeScope === sessionScope && this.startPromise === startPromise) {
        this.activeScope = undefined
        this.startPromise = undefined
        this.options.coordinator.stopSession()
      }
      throw error
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined
      }
    }
  }

  stop(): void {
    this.generation += 1
    this.activeScope = undefined
    this.startPromise = undefined
    this.options.coordinator.stopSession()
  }
}
