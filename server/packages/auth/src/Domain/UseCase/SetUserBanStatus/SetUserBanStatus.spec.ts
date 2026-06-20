import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SetUserBanStatus } from './SetUserBanStatus'

describe('SetUserBanStatus', () => {
  let user: User
  let userRepository: UserRepositoryInterface
  let timer: TimerInterface

  const validUuid = '00000000-0000-0000-0000-000000000001'

  const createUseCase = () => new SetUserBanStatus(userRepository, timer)

  beforeEach(() => {
    user = {
      uuid: validUuid,
      email: 'test@test.com',
      banned: false,
      bannedAt: null,
      banReason: null,
    } as unknown as User
    user.isBanned = function (this: User) {
      return this.banned === true
    }

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)
    userRepository.save = jest.fn().mockImplementation((u: User) => Promise.resolve(u))

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date('2026-06-20T00:00:00.000Z'))
  })

  it('should fail for an invalid uuid', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid', banned: true })

    expect(result.isFailed()).toBeTruthy()
    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when the user does not exist', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: validUuid, banned: true })

    expect(result.isFailed()).toBeTruthy()
    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should ban a user and record the timestamp and reason', async () => {
    const result = await createUseCase().execute({ userUuid: validUuid, banned: true, banReason: 'spam' })

    expect(result.isFailed()).toBeFalsy()
    const saved = result.getValue()
    expect(saved.banned).toBe(true)
    expect(saved.isBanned()).toBe(true)
    expect(saved.bannedAt).toEqual(new Date('2026-06-20T00:00:00.000Z'))
    expect(saved.banReason).toEqual('spam')
    expect(userRepository.save).toHaveBeenCalledWith(user)
  })

  it('should unban a user and clear ban metadata', async () => {
    user.banned = true
    user.bannedAt = new Date('2026-01-01T00:00:00.000Z')
    user.banReason = 'spam'

    const result = await createUseCase().execute({ userUuid: validUuid, banned: false })

    expect(result.isFailed()).toBeFalsy()
    const saved = result.getValue()
    expect(saved.banned).toBe(false)
    expect(saved.isBanned()).toBe(false)
    expect(saved.bannedAt).toBeNull()
    expect(saved.banReason).toBeNull()
  })
})
