import { Uuid } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { ListPendingMfaApprovals } from './ListPendingMfaApprovals'

describe('ListPendingMfaApprovals', () => {
  let pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const approval = (label: string, actionable: boolean) =>
    ({
      props: { challengeId: label },
      isActionable: jest.fn().mockReturnValue(actionable),
    }) as unknown as jest.Mocked<PendingMfaApproval>

  const createUseCase = () => new ListPendingMfaApprovals(pendingMfaApprovalRepository)

  beforeEach(() => {
    pendingMfaApprovalRepository = {} as jest.Mocked<PendingMfaApprovalRepositoryInterface>
    pendingMfaApprovalRepository.findPendingByUserUuid = jest.fn().mockResolvedValue([])
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list pending MFA approvals')
    expect(pendingMfaApprovalRepository.findPendingByUserUuid).not.toHaveBeenCalled()
  })

  it('should drop approvals that are no longer actionable', async () => {
    const actionable = approval('live', true)
    const expired = approval('expired', false)
    pendingMfaApprovalRepository.findPendingByUserUuid = jest.fn().mockResolvedValue([actionable, expired])

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual([actionable])
  })

  it('should scope the query to the requesting user and judge actionability against the current time', async () => {
    const before = Date.now()
    const actionable = approval('live', true)
    pendingMfaApprovalRepository.findPendingByUserUuid = jest.fn().mockResolvedValue([actionable])

    await createUseCase().execute({ userUuid })

    const queriedUuid = (pendingMfaApprovalRepository.findPendingByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)

    const nowPassed = (actionable.isActionable as jest.Mock).mock.calls[0][0] as number
    expect(nowPassed).toBeGreaterThanOrEqual(before)
    expect(nowPassed).toBeLessThanOrEqual(Date.now())
  })
})
