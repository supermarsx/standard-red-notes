import { EntityManager } from 'typeorm'

import { AuthInviteEventTransactionContext } from '../../Infra/TypeORM/AuthInviteEventTransactionContext'
import { AuthInviteRealtimeOutboxProducer } from './AuthInviteRealtimeOutboxProducer'
import { InviteEventOutboxRepositoryInterface } from './InviteEventOutboxRepositoryInterface'

/**
 * The producer is the only way invite realtime events enter the outbox, and its
 * guards are what keep a malformed or out-of-transaction event from being durably
 * enqueued — at which point the dispatcher would retry it forever.
 */
describe('AuthInviteRealtimeOutboxProducer', () => {
  const inviteUuid = '00000000-0000-4000-8000-000000000001'
  const firstUser = '00000000-0000-4000-8000-0000000000a1'
  const secondUser = '00000000-0000-4000-8000-0000000000a2'
  const eventId = '00000000-0000-4000-8000-0000000000e1'

  let repository: jest.Mocked<InviteEventOutboxRepositoryInterface>
  let transactionContext: AuthInviteEventTransactionContext

  beforeEach(() => {
    repository = {
      enqueue: jest.fn().mockResolvedValue('inserted'),
    } as unknown as jest.Mocked<InviteEventOutboxRepositoryInterface>
    transactionContext = new AuthInviteEventTransactionContext()
  })

  const producer = () =>
    new AuthInviteRealtimeOutboxProducer(
      repository,
      transactionContext,
      () => 1_700_000_000_000,
      () => eventId,
    )

  const inTransaction = <T>(operation: () => Promise<T>): Promise<T> =>
    transactionContext.run({} as EntityManager, operation)

  const record = (overrides: Record<string, unknown> = {}) =>
    producer().recordSubscriptionInvite({
      action: 'created',
      inviteUuid,
      affectedUserUuids: [firstUser],
      ...overrides,
    } as never)

  it('enqueues a canonical metadata-only event inside the transaction', async () => {
    await expect(inTransaction(() => record())).resolves.toBe('inserted')

    expect(repository.enqueue).toHaveBeenCalledTimes(1)
    expect(repository.enqueue.mock.calls[0][0]).toMatchObject({
      eventId,
      type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
      payload: {
        version: 1,
        recordId: eventId,
        affectedUserUuids: [firstUser],
        event: { kind: 'subscription-invite', action: 'created', inviteUuid, occurredAt: 1_700_000_000_000 },
      },
    })
  })

  it('deduplicates and lowercases affected users', async () => {
    await inTransaction(() => record({ affectedUserUuids: [firstUser.toUpperCase(), firstUser, secondUser] }))

    expect(repository.enqueue.mock.calls[0][0].payload.affectedUserUuids).toEqual([firstUser, secondUser])
  })

  // Enqueueing outside the transaction would publish an event for a mutation that
  // may still roll back — the exact split-brain the outbox exists to prevent.
  it('refuses to enqueue outside the mutation transaction', async () => {
    await expect(record()).rejects.toThrow(
      'Auth invite realtime events must be enqueued inside the mutation transaction.',
    )
    expect(repository.enqueue).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-uuid event id', { eventId: 'not-a-uuid' }, 'Auth invite realtime event uuid is invalid.'],
    ['a non-uuid invitation', { inviteUuid: 'nope' }, 'Auth invite realtime invitation uuid is invalid.'],
    [
      'a non-uuid affected user',
      { affectedUserUuids: ['nope'] },
      'Auth invite realtime affected user uuid is invalid.',
    ],
    ['no affected users', { affectedUserUuids: [] }, 'Auth invite realtime affected users are invalid.'],
    [
      'more affected users than the fanout bound',
      { affectedUserUuids: Array.from({ length: 1_001 }, (_value, index) => uuidForIndex(index)) },
      'Auth invite realtime affected users are invalid.',
    ],
    ['a fractional occurrence time', { occurredAt: 1.5 }, 'Auth invite realtime occurrence time is invalid.'],
    ['a zero occurrence time', { occurredAt: 0 }, 'Auth invite realtime occurrence time is invalid.'],
    ['an unsafe occurrence time', { occurredAt: Number.MAX_VALUE }, 'Auth invite realtime occurrence time is invalid.'],
  ])('rejects %s', async (_case, overrides, message) => {
    await expect(inTransaction(() => record(overrides))).rejects.toThrow(message)
    expect(repository.enqueue).not.toHaveBeenCalled()
  })

  it('reports an idempotent re-enqueue as a duplicate rather than a new record', async () => {
    repository.enqueue.mockResolvedValue('duplicate')

    await expect(inTransaction(() => record())).resolves.toBe('duplicate')
  })
})

function uuidForIndex(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}
