import 'reflect-metadata'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SendApprovalNotification } from '../SendApprovalNotification/SendApprovalNotification'

import { ApproveUser } from './ApproveUser'

describe('ApproveUser', () => {
  let userRepository: jest.Mocked<UserRepositoryInterface>
  let timer: jest.Mocked<TimerInterface>
  let sendApprovalNotification: jest.Mocked<SendApprovalNotification>
  let user: User

  const validUuid = '00000000-0000-0000-0000-000000000001'

  beforeEach(() => {
    user = new User()
    user.uuid = validUuid
    user.email = 'p@example.com'
    user.approved = false

    userRepository = {
      findOneByUuid: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation((u: User) => Promise.resolve(u)),
    } as unknown as jest.Mocked<UserRepositoryInterface>

    timer = { getUTCDate: jest.fn().mockReturnValue(new Date(1000)) } as unknown as jest.Mocked<TimerInterface>

    sendApprovalNotification = {
      execute: jest.fn().mockResolvedValue({ isFailed: () => false }),
    } as unknown as jest.Mocked<SendApprovalNotification>
  })

  it('approves the user (approved=1 + approved_at) and notifies', async () => {
    const result = await new ApproveUser(userRepository, timer, sendApprovalNotification, 'https://app').execute({
      userUuid: validUuid,
    })

    expect(result.isFailed()).toBe(false)
    const saved = (userRepository.save as jest.Mock).mock.calls[0][0] as User
    expect(saved.approved).toBe(true)
    expect(saved.approvedAt).toEqual(new Date(1000))
    expect(sendApprovalNotification.execute).toHaveBeenCalledWith({
      userUuid: validUuid,
      email: 'p@example.com',
      signInUrl: 'https://app',
    })
  })

  it('still succeeds if the approval email throws (best-effort)', async () => {
    sendApprovalNotification.execute = jest.fn().mockRejectedValue(new Error('smtp down'))

    const result = await new ApproveUser(userRepository, timer, sendApprovalNotification).execute({
      userUuid: validUuid,
    })

    expect(result.isFailed()).toBe(false)
  })

  it('fails for a missing user', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await new ApproveUser(userRepository, timer).execute({ userUuid: validUuid })

    expect(result.isFailed()).toBe(true)
  })

  it('fails for an invalid uuid', async () => {
    const result = await new ApproveUser(userRepository, timer).execute({ userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBe(true)
  })

  it('persists the approval note when one is supplied', async () => {
    const result = await new ApproveUser(userRepository, timer, sendApprovalNotification, 'https://app').execute({
      userUuid: validUuid,
      approvalNote: 'verified by support',
    })

    expect(result.isFailed()).toBe(false)
    const saved = (userRepository.save as jest.Mock).mock.calls[0][0] as User
    expect(saved.approvalNote).toEqual('verified by support')
  })
})
