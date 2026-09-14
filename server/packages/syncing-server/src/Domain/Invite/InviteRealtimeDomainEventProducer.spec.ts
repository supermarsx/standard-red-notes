import { InviteRealtimeInvalidationRequestedEvent } from '@standardnotes/domain-events'

import { SyncCommandOutboxRepositoryInterface } from '../SyncCommand/SyncCommandOutboxRepositoryInterface'
import { CANONICAL_REVISION_PATTERN, InviteRealtimeDomainEventProducer } from './InviteRealtimeDomainEventProducer'

describe('InviteRealtimeDomainEventProducer', () => {
  const SHARED_VAULT_UUID = '00000000-0000-4000-8000-000000000001'
  const MEMBER_UUID = '00000000-0000-4000-8000-000000000002'
  const MEMBERSHIP_UUID = '30000000-0000-4000-8000-000000000011'
  const EVENT_ID = '40000000-0000-4000-8000-000000000001'

  let outboxRepository: jest.Mocked<SyncCommandOutboxRepositoryInterface>
  let producer: InviteRealtimeDomainEventProducer

  const membership = (revision: string) => ({
    action: 'revoked' as const,
    sharedVaultUuid: SHARED_VAULT_UUID,
    memberUserUuid: MEMBER_UUID,
    membershipUuid: MEMBERSHIP_UUID,
    revision,
    affectedUserUuids: [MEMBER_UUID],
    eventId: EVENT_ID,
    occurredAt: 1_789_150_108_395,
  })

  beforeEach(() => {
    outboxRepository = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      claimNext: jest.fn(),
      markPublished: jest.fn(),
      releaseForRetry: jest.fn(),
      markDead: jest.fn(),
      deletePublishedBefore: jest.fn(),
    }
    producer = new InviteRealtimeDomainEventProducer(outboxRepository)
  })

  /**
   * Membership revision contract (t92 C12). The syncing-server outbox enqueues
   * the event directly (the domain-events validator only runs on auth's
   * outbox), so a malformed revision has to be rejected here or it reaches the
   * gateway and the client fence.
   */
  describe('membership revision precheck', () => {
    it('shares the canonical pattern with the domain-events validator', () => {
      expect(CANONICAL_REVISION_PATTERN.source).toBe('^[1-9]\\d{0,31}$')
      expect(CANONICAL_REVISION_PATTERN.flags).toBe('u')
    })

    it('enqueues a membership event carrying the canonical revision verbatim', async () => {
      await producer.recordSharedVaultMembership(membership('1789150108395094'))

      expect(outboxRepository.enqueue).toHaveBeenCalledTimes(1)
      const event = outboxRepository.enqueue.mock.calls[0][0] as InviteRealtimeInvalidationRequestedEvent
      expect(event.type).toBe('INVITE_REALTIME_INVALIDATION_REQUESTED')
      expect(event.payload.event).toEqual(
        expect.objectContaining({
          kind: 'shared-vault-membership',
          action: 'revoked',
          membershipUuid: MEMBERSHIP_UUID,
          revision: '1789150108395094',
        }),
      )
    })

    it('accepts the smallest and the longest canonical revisions', async () => {
      await producer.recordSharedVaultMembership(membership('1'))
      await producer.recordSharedVaultMembership(membership('9'.repeat(32)))

      expect(outboxRepository.enqueue).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['empty', ''],
      ['zero', '0'],
      ['leading zero', '0123'],
      ['negative', '-1'],
      ['decimal point', '1789150108395094.5'],
      ['exponent', '1e15'],
      ['letters', 'abc'],
      ['surrounding whitespace', ' 1789150108395094 '],
      ['trailing newline', '1789150108395094\n'],
      ['33 digits', '1'.repeat(33)],
      ['unicode digits', '١٢٣'],
      ['128 non-canonical characters (the old length-only precheck let this through)', 'x'.repeat(128)],
    ])('rejects a malformed revision (%s) before anything reaches the outbox', (_label, revision) => {
      // The precheck throws synchronously, before the method returns its promise,
      // so a bad revision surfaces on the caller's stack inside the mutation
      // transaction rather than as a rejected outbox write.
      expect(() => producer.recordSharedVaultMembership(membership(revision))).toThrow(
        'Invite realtime membership revision is invalid.',
      )

      expect(outboxRepository.enqueue).not.toHaveBeenCalled()
    })

    it('rejects a non-string revision that slipped past the types', () => {
      expect(() => producer.recordSharedVaultMembership(membership(1789150108395094 as unknown as string))).toThrow(
        'Invite realtime membership revision is invalid.',
      )

      expect(outboxRepository.enqueue).not.toHaveBeenCalled()
    })
  })
})
