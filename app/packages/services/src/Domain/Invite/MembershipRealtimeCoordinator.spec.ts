import { InviteRealtimeEvent, SharedVaultMembershipRealtimeEvent } from './InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from './InviteRealtimeEventConsumer'
import { MembershipRealtimeCoordinator, MembershipRealtimeTarget } from './MembershipRealtimeCoordinator'

const currentUserUuid = '00000000-0000-4000-8000-000000000001'
const otherUserUuid = '00000000-0000-4000-8000-000000000002'
const sharedVaultUuid = '10000000-0000-4000-8000-000000000001'
const membershipUuid = '20000000-0000-4000-8000-000000000001'

const context = {
  sessionScope: 'account-a',
  sessionEpoch: 1,
  signal: new AbortController().signal,
  isCurrent: () => true,
  assertCurrent: jest.fn(),
} satisfies InviteRealtimeHandlerContext

const membershipEvent = (
  action: SharedVaultMembershipRealtimeEvent['action'],
  overrides: Partial<SharedVaultMembershipRealtimeEvent> = {},
): SharedVaultMembershipRealtimeEvent => ({
  version: 1,
  eventId: '00000000-0000-4000-8000-000000000010',
  streamPosition: 'cursor-1',
  kind: 'shared-vault-membership',
  action,
  sharedVaultUuid,
  memberUserUuid: otherUserUuid,
  membershipUuid,
  revision: '1',
  occurredAt: 1,
  ...overrides,
})

const createTarget = (): jest.Mocked<MembershipRealtimeTarget> => ({
  getCurrentUserUuid: jest.fn().mockReturnValue(currentUserUuid),
  applyMembershipDelta: jest.fn(),
  evictSharedVault: jest.fn(),
  persistMembershipNotification: jest.fn(),
  applyApplicationStateInvalidation: jest.fn(),
})

describe('MembershipRealtimeCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each<SharedVaultMembershipRealtimeEvent['action']>([
    'invited',
    'accepted',
    'joined',
    'left',
    'revoked',
    'role-changed',
  ])('applies and durably notifies the %s membership delta', async (action) => {
    const target = createTarget()
    const coordinator = new MembershipRealtimeCoordinator(target)
    const event = membershipEvent(action)

    await coordinator.handle([event], context)

    expect(target.applyMembershipDelta).toHaveBeenCalledWith(event, context)
    expect(target.persistMembershipNotification).toHaveBeenCalledWith(event, context)
  })

  it.each<SharedVaultMembershipRealtimeEvent['action']>(['left', 'revoked'])(
    'evicts a current-user %s before durably recording its notification',
    async (action) => {
      const order: string[] = []
      const target = createTarget()
      target.evictSharedVault.mockImplementation(async () => {
        order.push('evict')
      })
      target.persistMembershipNotification.mockImplementation(async () => {
        order.push('notify')
      })
      const coordinator = new MembershipRealtimeCoordinator(target)
      const event = membershipEvent(action, { memberUserUuid: currentUserUuid })

      await coordinator.handle([event], context)

      expect(target.applyMembershipDelta).not.toHaveBeenCalled()
      expect(target.evictSharedVault).toHaveBeenCalledWith(sharedVaultUuid, event, context)
      expect(order).toEqual(['evict', 'notify'])
    },
  )

  it('awaits application-state invalidations without any snapshot or binary payload path', async () => {
    const target = createTarget()
    let release!: () => void
    target.applyApplicationStateInvalidation.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const coordinator = new MembershipRealtimeCoordinator(target)
    const event: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000011',
      streamPosition: 'cursor-2',
      kind: 'application-state',
      action: 'invalidated',
      resource: 'items',
      revision: '7',
      occurredAt: 2,
    }

    const applying = coordinator.handle([event], context)
    await Promise.resolve()
    expect(target.applyApplicationStateInvalidation).toHaveBeenCalledWith(event, context)
    let settled = false
    void applying.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await applying
  })

  it('fails before ACK when durable notification persistence fails', async () => {
    const target = createTarget()
    target.persistMembershipNotification.mockRejectedValue(new Error('durable store unavailable'))
    const coordinator = new MembershipRealtimeCoordinator(target)

    await expect(coordinator.handle([membershipEvent('joined')], context)).rejects.toThrow('durable store unavailable')
  })
})
