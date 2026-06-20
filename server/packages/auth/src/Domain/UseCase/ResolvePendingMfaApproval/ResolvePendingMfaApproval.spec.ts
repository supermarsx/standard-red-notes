import { UniqueEntityId } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalStatus } from '../../PendingMfaApproval/PendingMfaApprovalProps'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { ResolvePendingMfaApproval } from './ResolvePendingMfaApproval'

describe('ResolvePendingMfaApproval', () => {
  let pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface

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

  const createUseCase = () => new ResolvePendingMfaApproval(pendingMfaApprovalRepository)

  beforeEach(() => {
    pendingMfaApprovalRepository = {} as jest.Mocked<PendingMfaApprovalRepositoryInterface>
    pendingMfaApprovalRepository.findByChallengeId = jest.fn().mockResolvedValue(buildApproval())
    pendingMfaApprovalRepository.save = jest.fn().mockResolvedValue(undefined)
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
    pendingMfaApprovalRepository.findByChallengeId = jest
      .fn()
      .mockResolvedValue(buildApproval({ status: 'approved' }))

    const result = await createUseCase().execute({ userUuid, challengeId, approve: true })

    expect(result.isFailed()).toBe(true)
  })
})
