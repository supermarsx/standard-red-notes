import { InviteRealtimeEvent } from './InviteRealtimeEvent'
import { InviteRealtimeInvalidationRouter } from './InviteRealtimeInvalidationRouter'

const event = (kind: 'shared-vault-invite' | 'subscription-invite', index: number): InviteRealtimeEvent => {
  const base = {
    version: 1 as const,
    eventId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    streamPosition: `cursor-${index}`,
    action: 'created' as const,
    inviteUuid: '10000000-0000-4000-8000-000000000001',
    occurredAt: index,
  }
  return kind === 'shared-vault-invite'
    ? { ...base, kind, sharedVaultUuid: '20000000-0000-4000-8000-000000000001' }
    : { ...base, kind }
}

describe('InviteRealtimeInvalidationRouter', () => {
  it('coalesces a replay batch into one refresh for each affected invite domain', async () => {
    const reloadSharedVaultInvites = jest.fn()
    const refreshSubscriptionInvites = jest.fn()
    const applyAccountStateEvents = jest.fn()
    const router = new InviteRealtimeInvalidationRouter({
      reloadSharedVaultInvites,
      refreshSubscriptionInvites,
      applyAccountStateEvents,
    })
    const shared = [event('shared-vault-invite', 1), event('shared-vault-invite', 2)]
    const subscription = event('subscription-invite', 3)

    await router.handle([...shared, subscription])

    expect(reloadSharedVaultInvites).toHaveBeenCalledTimes(1)
    expect(reloadSharedVaultInvites).toHaveBeenCalledWith(shared, undefined)
    expect(refreshSubscriptionInvites).toHaveBeenCalledTimes(1)
    expect(refreshSubscriptionInvites).toHaveBeenCalledWith([subscription], undefined)
  })

  it('does not call an unaffected domain', async () => {
    const reloadSharedVaultInvites = jest.fn()
    const refreshSubscriptionInvites = jest.fn()
    const applyAccountStateEvents = jest.fn()
    const router = new InviteRealtimeInvalidationRouter({
      reloadSharedVaultInvites,
      refreshSubscriptionInvites,
      applyAccountStateEvents,
    })

    await router.handle([event('subscription-invite', 1)])

    expect(reloadSharedVaultInvites).not.toHaveBeenCalled()
    expect(refreshSubscriptionInvites).toHaveBeenCalledTimes(1)
  })

  it('rejects the batch when an authoritative refresh fails so the cursor is not ACKed', async () => {
    const router = new InviteRealtimeInvalidationRouter({
      reloadSharedVaultInvites: async () => {
        throw new Error('HTTP reload failed')
      },
      refreshSubscriptionInvites: jest.fn(),
      applyAccountStateEvents: jest.fn(),
    })

    await expect(router.handle([event('shared-vault-invite', 1)])).rejects.toThrow('HTTP reload failed')
  })

  it('preserves membership and application-state ordering behind an exact session context', async () => {
    const applyAccountStateEvents = jest.fn()
    const router = new InviteRealtimeInvalidationRouter({
      reloadSharedVaultInvites: jest.fn(),
      refreshSubscriptionInvites: jest.fn(),
      applyAccountStateEvents,
    })
    const membership: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000004',
      streamPosition: 'cursor-4',
      kind: 'shared-vault-membership',
      action: 'joined',
      sharedVaultUuid: '20000000-0000-4000-8000-000000000001',
      memberUserUuid: '30000000-0000-4000-8000-000000000001',
      membershipUuid: '40000000-0000-4000-8000-000000000001',
      role: 'write',
      revision: '1',
      occurredAt: 4,
    }
    const application: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000005',
      streamPosition: 'cursor-5',
      kind: 'application-state',
      action: 'invalidated',
      resource: 'shared-vaults',
      resourceUuid: membership.sharedVaultUuid,
      revision: '1',
      occurredAt: 5,
    }
    const context = {
      sessionScope: 'account-a',
      sessionEpoch: 1,
      signal: new AbortController().signal,
      isCurrent: () => true,
      assertCurrent: jest.fn(),
    }

    await router.handle([membership, application], context)

    expect(applyAccountStateEvents).toHaveBeenCalledWith([membership, application], context)
  })
})
