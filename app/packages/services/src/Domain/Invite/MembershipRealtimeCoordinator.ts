import {
  ApplicationStateRealtimeEvent,
  InviteRealtimeEvent,
  SharedVaultMembershipRealtimeEvent,
} from './InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from './InviteRealtimeEventConsumer'

export interface MembershipRealtimeTarget {
  getCurrentUserUuid(): string | undefined

  /**
   * Apply a metadata delta without fetching an HTTP snapshot. Must be
   * idempotent by revision and assert context immediately before mutation.
   */
  applyMembershipDelta(
    event: SharedVaultMembershipRealtimeEvent,
    context: InviteRealtimeHandlerContext,
  ): void | Promise<void>

  /**
   * Remove local vault data/capabilities immediately. Must assert context
   * before eviction and be safe to retry.
   */
  evictSharedVault(
    sharedVaultUuid: string,
    event: SharedVaultMembershipRealtimeEvent,
    context: InviteRealtimeHandlerContext,
  ): void | Promise<void>

  /**
   * Durably upsert a user-visible record keyed by event.eventId. The promise
   * must resolve only after persistence so the stream cursor cannot ACK first.
   */
  persistMembershipNotification(
    event: SharedVaultMembershipRealtimeEvent,
    context: InviteRealtimeHandlerContext,
  ): void | Promise<void>

  /**
   * Trigger an existing incremental state path after asserting context;
   * binary bodies/assets are never present.
   */
  applyApplicationStateInvalidation(
    event: ApplicationStateRealtimeEvent,
    context: InviteRealtimeHandlerContext,
  ): void | Promise<void>
}

/** Applies revision-fenced durable deltas in stream order before cursor ACK. */
export class MembershipRealtimeCoordinator {
  constructor(private readonly target: MembershipRealtimeTarget) {}

  async handle(events: readonly InviteRealtimeEvent[], context: InviteRealtimeHandlerContext): Promise<void> {
    for (const event of events) {
      context.assertCurrent()
      switch (event.kind) {
        case 'shared-vault-membership':
          await this.handleMembershipEvent(event, context)
          break
        case 'application-state':
          await this.target.applyApplicationStateInvalidation(event, context)
          break
      }
      context.assertCurrent()
    }
  }

  private async handleMembershipEvent(
    event: SharedVaultMembershipRealtimeEvent,
    context: InviteRealtimeHandlerContext,
  ): Promise<void> {
    const currentUserUuid = this.target.getCurrentUserUuid()
    if (!currentUserUuid) {
      throw new Error('Cannot apply a shared-vault membership delta without an authenticated user.')
    }

    const revokesCurrentUser =
      event.memberUserUuid === currentUserUuid && (event.action === 'left' || event.action === 'revoked')
    if (revokesCurrentUser) {
      await this.target.evictSharedVault(event.sharedVaultUuid, event, context)
    } else {
      await this.target.applyMembershipDelta(event, context)
    }
    context.assertCurrent()
    await this.target.persistMembershipNotification(event, context)
  }
}
