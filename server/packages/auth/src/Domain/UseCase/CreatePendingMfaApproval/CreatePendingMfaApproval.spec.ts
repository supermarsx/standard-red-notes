import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

import { CreatePendingMfaApproval } from './CreatePendingMfaApproval'

describe('CreatePendingMfaApproval', () => {
  let pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let logger: Logger

  const ttlSeconds = 120
  const userUuid = '00000000-0000-0000-0000-000000000000'

  const dto = {
    userUuid,
    requestingUserAgent: 'Chrome on macOS',
    requestingIpAddress: '1.2.3.4',
  }

  const createUseCase = () =>
    new CreatePendingMfaApproval(
      pendingMfaApprovalRepository,
      domainEventPublisher,
      domainEventFactory,
      logger,
      ttlSeconds,
    )

  beforeEach(() => {
    pendingMfaApprovalRepository = {} as jest.Mocked<PendingMfaApprovalRepositoryInterface>
    pendingMfaApprovalRepository.save = jest.fn().mockResolvedValue(undefined)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn().mockResolvedValue(undefined)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createWebSocketMessageRequestedEvent = jest.fn().mockReturnValue({ type: 'WS' })

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.debug = jest.fn()
  })

  it('should fail on an invalid user uuid', async () => {
    const result = await createUseCase().execute({ ...dto, userUuid: 'invalid' })
    expect(result.isFailed()).toBe(true)
  })

  it('should persist a pending approval with a TTL and a high-entropy challenge id', async () => {
    const before = Date.now()
    const result = await createUseCase().execute(dto)
    const after = Date.now()

    expect(result.isFailed()).toBe(false)
    const { challengeId, expiresAt } = result.getValue()
    expect(challengeId.length).toBeGreaterThan(20)
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlSeconds * 1000)
    expect(expiresAt).toBeLessThanOrEqual(after + ttlSeconds * 1000)

    const saved = (pendingMfaApprovalRepository.save as jest.Mock).mock.calls[0][0] as PendingMfaApproval
    expect(saved.props.status).toBe('pending')
    expect(saved.props.consumed).toBe(false)
    expect(saved.props.requestingUserAgent).toBe('Chrome on macOS')
    expect(saved.props.requestingIpAddress).toBe('1.2.3.4')
  })

  it('should push an approval-request frame to the other sessions over the gateway', async () => {
    await createUseCase().execute(dto)

    expect(domainEventFactory.createWebSocketMessageRequestedEvent).toHaveBeenCalledTimes(1)
    const arg = (domainEventFactory.createWebSocketMessageRequestedEvent as jest.Mock).mock.calls[0][0]
    expect(arg.userUuid).toBe(userUuid)
    const frame = JSON.parse(arg.message)
    expect(frame.type).toBe('MFA_APPROVAL_REQUESTED')
    expect(typeof frame.challengeId).toBe('string')
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
  })

  it('should still succeed when the websocket push fails (best-effort)', async () => {
    domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('bus down'))

    const result = await createUseCase().execute(dto)

    expect(result.isFailed()).toBe(false)
    expect(logger.error).toHaveBeenCalled()
  })
})
