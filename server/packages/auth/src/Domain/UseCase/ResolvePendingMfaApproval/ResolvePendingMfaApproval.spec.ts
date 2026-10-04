import { UniqueEntityId } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalStatus } from '../../PendingMfaApproval/PendingMfaApprovalProps'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

import { ResolvePendingMfaApproval } from './ResolvePendingMfaApproval'

describe('ResolvePendingMfaApproval', () => {
  let pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const challengeId = 'challenge-abc'

  const buildApproval = (
    overrides: { owner?: string; status?: PendingMfaApprovalStatus; consumed?: boolean; expiresAt?: number } = {},
  ) =>
    PendingMfaApproval.create(
      {
        userUuid: overrides.owner ?? userUuid,
        challengeId,
        status: overrides.status ?? 'pending',
        requestingUserAgent: 'Chrome',
        requestingIpAddress: '1.2.3.4',
        createdAt: Date.now() - 1000,
        expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
        consumed: overrides.consumed ?? false,
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  const createUseCase = () =>
    new ResolvePendingMfaApproval(pendingMfaApprovalRepository, domainEventPublisher, domainEventFactory, logger)

  beforeEach(() => {
    pendingMfaApprovalRepository = {} as jest.Mocked<PendingMfaApprovalRepositoryInterface>
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval())
    pendingMfaApprovalRepository.save = jest.fn().mockResolvedValue(undefined)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn().mockResolvedValue(undefined)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createWebSocketMessageRequestedEvent = jest.fn().mockReturnValue({ type: 'WS' })

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.debug = jest.fn()
  })

  it('should approve a pending, owned, actionable approval', async () => {
    const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe('approved')
    const saved = (pendingMfaApprovalRepository.save as jest.Mock).mock.calls[0][0] as PendingMfaApproval
    expect(saved.props.status).toBe('approved')
  })

  it('should deny and block the login when approve is false', async () => {
    const result = await createUseCase().execute({ userUuid, challengeId, approve: false })

    expect(result.getValue()).toBe('denied')
    const saved = (pendingMfaApprovalRepository.save as jest.Mock).mock.calls[0][0] as PendingMfaApproval
    expect(saved.props.status).toBe('denied')
  })

  it('should reject resolving another account approval (ownership)', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest
      .fn()
      .mockResolvedValue(buildApproval({ owner: '99999999-9999-9999-9999-999999999999' }))

    const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

    expect(result.isFailed()).toBe(true)
    expect(pendingMfaApprovalRepository.save).not.toHaveBeenCalled()
  })

  it('should reject resolving an expired approval (TTL)', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest
      .fn()
      .mockResolvedValue(buildApproval({ expiresAt: Date.now() - 1 }))

    const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

    expect(result.isFailed()).toBe(true)
    expect(pendingMfaApprovalRepository.save).not.toHaveBeenCalled()
  })

  it('should reject resolving an already-resolved approval (single-use)', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval({ status: 'approved' }))

    const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

    expect(result.isFailed()).toBe(true)
  })

  it('fails on a malformed user uuid before looking the challenge up', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid', challengeId, approve: true })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not resolve MFA approval')
    expect(pendingMfaApprovalRepository.findByChallengeId).not.toHaveBeenCalled()
  })

  /**
   * The realtime half: the DECISION is announced to the account's other sessions so
   * an inbox they are already showing can drop the row without re-GETting it. This
   * is what lets the web inbox stop polling every 6 s on a healthy socket.
   */
  describe('MFA_APPROVAL_RESOLVED push', () => {
    it('announces an approval to the account other sessions', async () => {
      await createUseCase().execute({ userUuid, challengeId, approve: true })

      expect(domainEventFactory.createWebSocketMessageRequestedEvent).toHaveBeenCalledTimes(1)
      const arg = (domainEventFactory.createWebSocketMessageRequestedEvent as jest.Mock).mock.calls[0][0]
      expect(arg.userUuid).toBe(userUuid)
      const frame = JSON.parse(arg.message)
      expect(frame.type).toBe('MFA_APPROVAL_RESOLVED')
      expect(frame.challengeId).toBe(challengeId)
      expect(frame.status).toBe('approved')
      expect(typeof frame.resolvedAt).toBe('number')
      expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    })

    it('announces a denial with the denied status', async () => {
      await createUseCase().execute({ userUuid, challengeId, approve: false })

      const arg = (domainEventFactory.createWebSocketMessageRequestedEvent as jest.Mock).mock.calls[0][0]
      expect(JSON.parse(arg.message).status).toBe('denied')
    })

    it('publishes only after the resolution is durably saved', async () => {
      const order: string[] = []
      pendingMfaApprovalRepository.save = jest.fn().mockImplementation(async () => {
        order.push('save')
      })
      domainEventPublisher.publish = jest.fn().mockImplementation(async () => {
        order.push('publish')
      })

      await createUseCase().execute({ userUuid, challengeId, approve: true })

      expect(order).toEqual(['save', 'publish'])
    })

    it('still succeeds when the push fails, because the poll is the fallback', async () => {
      domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('bus down'))

      const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

      expect(result.isFailed()).toBe(false)
      expect(result.getValue()).toBe('approved')
      expect(logger.error).toHaveBeenCalled()
    })

    it('never announces a refused resolution', async () => {
      pendingMfaApprovalRepository.findByChallengeId = jest
        .fn()
        .mockResolvedValue(buildApproval({ owner: '99999999-9999-9999-9999-999999999999' }))

      await createUseCase().execute({ userUuid, challengeId, approve: true })

      expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    })
  })
})
