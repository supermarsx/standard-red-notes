import { InviteRealtimeEvent } from './InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from './InviteRealtimeEventConsumer'

export type InviteRealtimeInvalidationTargets = {
  reloadSharedVaultInvites(
    events: readonly InviteRealtimeEvent[],
    context?: InviteRealtimeHandlerContext,
  ): void | Promise<void>
  refreshSubscriptionInvites(
    events: readonly InviteRealtimeEvent[],
    context?: InviteRealtimeHandlerContext,
  ): void | Promise<void>
  applyAccountStateEvents(
    events: readonly InviteRealtimeEvent[],
    context: InviteRealtimeHandlerContext,
  ): void | Promise<void>
}

/** Coalesces a replay batch into at most one authoritative refresh per invite domain. */
export class InviteRealtimeInvalidationRouter {
  constructor(private readonly targets: InviteRealtimeInvalidationTargets) {}

  async handle(events: readonly InviteRealtimeEvent[], context?: InviteRealtimeHandlerContext): Promise<void> {
    const sharedVaultEvents = events.filter((event) => event.kind === 'shared-vault-invite')
    const subscriptionEvents = events.filter((event) => event.kind === 'subscription-invite')
    const accountStateEvents = events.filter(
      (event) => event.kind === 'shared-vault-membership' || event.kind === 'application-state',
    )
    const refreshes: Promise<void>[] = []

    if (sharedVaultEvents.length > 0) {
      refreshes.push(Promise.resolve(this.targets.reloadSharedVaultInvites(sharedVaultEvents, context)))
    }
    if (subscriptionEvents.length > 0) {
      refreshes.push(Promise.resolve(this.targets.refreshSubscriptionInvites(subscriptionEvents, context)))
    }
    if (accountStateEvents.length > 0) {
      if (!context) {
        throw new Error('Durable account-state events require an exact realtime session context.')
      }
      refreshes.push(Promise.resolve(this.targets.applyAccountStateEvents(accountStateEvents, context)))
    }
    await Promise.all(refreshes)
  }
}
