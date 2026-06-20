import { UniqueEntityId } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalStatus } from '../../PendingMfaApproval/PendingMfaApprovalProps'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { GetPendingMfaApprovalStatus } from './GetPendingMfaApprovalStatus'

describe('GetPendingMfaApprovalStatus', () => {
  let pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface

  const challengeId = 'challenge-abc'

  const buildApproval = (
    overrides: { status?: PendingMfaApprovalStatus; consumed?: boolean; expiresAt?: number } = {},
  ) =>
    PendingMfaApproval.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
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

  const createUseCase = () => new GetPendingMfaApprovalStatus(pendingMfaApprovalRepository)

  beforeEach(() => {
    pendingMfaApprovalRepository = {} as jest.Mocked<PendingMfaApprovalRepositoryInterface>
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval())
    pendingMfaApprovalRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should report expired when no challenge id is provided', async () => {
    const result = await createUseCase().execute({ challengeId: '' })
    expect(result.getValue().status).toBe('expired')
  })

  it('should report expired when the approval does not exist', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(null)
    const result = await createUseCase().execute({ challengeId })
    expect(result.getValue().status).toBe('expired')
  })

  it('should report pending while awaiting a trusted session', async () => {
    const result = await createUseCase().execute({ challengeId })
    expect(result.getValue().status).toBe('pending')
  })

  it('should report denied (terminal) when the request was denied', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval({ status: 'denied' }))
    const result = await createUseCase().execute({ challengeId })
    expect(result.getValue().status).toBe('denied')
  })

  it('should report approved exactly once then consume it (single-use)', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval({ status: 'approved' }))

    const result = await createUseCase().execute({ challengeId })

    expect(result.getValue().status).toBe('approved')
    expect(pendingMfaApprovalRepository.save).toHaveBeenCalledTimes(1)
    const saved = (pendingMfaApprovalRepository.save as jest.Mock).mock.calls[0][0] as PendingMfaApproval
    expect(saved.props.consumed).toBe(true)
  })

  it('should report expired for an already-consumed approval (replay blocked)', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest
      .fn()
      .mockResolvedValue(buildApproval({ status: 'approved', consumed: true }))

    const result = await createUseCase().execute({ challengeId })

    expect(result.getValue().status).toBe('expired')
    expect(pendingMfaApprovalRepository.save).not.toHaveBeenCalled()
  })

  it('should report expired once the TTL has elapsed', async () => {
    pendingMfaApprovalRepository.findByChallengeId = jest
      .fn()
      .mockResolvedValue(buildApproval({ status: 'approved', expiresAt: Date.now() - 1 }))

    const result = await createUseCase().execute({ challengeId })

    expect(result.getValue().status).toBe('expired')
  })
})
