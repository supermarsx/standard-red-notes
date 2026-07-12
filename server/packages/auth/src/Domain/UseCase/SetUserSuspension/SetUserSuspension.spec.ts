import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SessionRepositoryInterface } from '../../Session/SessionRepositoryInterface'
import { EphemeralSessionRepositoryInterface } from '../../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../../Session/RevokedSessionRepositoryInterface'
import { Session } from '../../Session/Session'
import { EphemeralSession } from '../../Session/EphemeralSession'
import { RevokedSession } from '../../Session/RevokedSession'
import { SetUserSuspension } from './SetUserSuspension'

describe('SetUserSuspension', () => {
  let user: User
  let userRepository: UserRepositoryInterface
  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let revokedSessionRepository: RevokedSessionRepositoryInterface
  let timer: TimerInterface

  const validUuid = '00000000-0000-0000-0000-000000000001'

  const createUseCase = () =>
    new SetUserSuspension(userRepository, sessionRepository, ephemeralSessionRepository, revokedSessionRepository, timer)

  beforeEach(() => {
    user = {
      uuid: validUuid,
      email: 'test@test.com',
      suspended: false,
      suspendedAt: null,
      suspendedReason: null,
    } as unknown as User
    user.isSuspended = function (this: User) {
      return Number(this.suspended) === 1
    }

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)
    userRepository.save = jest.fn().mockImplementation((u: User) => Promise.resolve(u))

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.findAllByUserUuid = jest
      .fn()
      .mockResolvedValue([{ uuid: 's-1', userUuid: validUuid } as unknown as Session])
    sessionRepository.remove = jest.fn().mockImplementation((s: Session) => Promise.resolve(s))

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.findAllByUserUuid = jest
      .fn()
      .mockResolvedValue([{ uuid: 'e-1', userUuid: validUuid } as unknown as EphemeralSession])
    ephemeralSessionRepository.deleteOne = jest.fn().mockResolvedValue(undefined)

    revokedSessionRepository = {} as jest.Mocked<RevokedSessionRepositoryInterface>
    revokedSessionRepository.findAllByUserUuid = jest
      .fn()
      .mockResolvedValue([{ uuid: 'r-1', userUuid: validUuid } as unknown as RevokedSession])
    revokedSessionRepository.remove = jest.fn().mockImplementation((s: RevokedSession) => Promise.resolve(s))

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date('2026-07-11T00:00:00.000Z'))
  })

  it('should fail for an invalid uuid', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid', suspended: true })

    expect(result.isFailed()).toBeTruthy()
    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when the user does not exist', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: validUuid, suspended: true })

    expect(result.isFailed()).toBeTruthy()
    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should suspend a user, recording the timestamp and reason', async () => {
    const result = await createUseCase().execute({ userUuid: validUuid, suspended: true, suspendedReason: 'review' })

    expect(result.isFailed()).toBeFalsy()
    const saved = result.getValue()
    expect(saved.suspended).toBe(true)
    expect(saved.isSuspended()).toBe(true)
    expect(saved.suspendedAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    expect(saved.suspendedReason).toEqual('review')
    expect(userRepository.save).toHaveBeenCalledWith(user)
  })

  it('should delete every session kind on suspend (immediate revocation)', async () => {
    await createUseCase().execute({ userUuid: validUuid, suspended: true })

    expect(sessionRepository.findAllByUserUuid).toHaveBeenCalledWith(validUuid)
    expect(sessionRepository.remove).toHaveBeenCalledTimes(1)
    expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith('e-1', validUuid)
    expect(revokedSessionRepository.remove).toHaveBeenCalledTimes(1)
  })

  it('should clear every suspension column on unsuspend and NOT touch sessions', async () => {
    user.suspended = true as unknown as boolean
    user.suspendedAt = new Date('2026-07-01T00:00:00.000Z')
    user.suspendedReason = 'review'

    const result = await createUseCase().execute({ userUuid: validUuid, suspended: false })

    expect(result.isFailed()).toBeFalsy()
    const saved = result.getValue()
    expect(saved.suspended).toBe(false)
    expect(saved.isSuspended()).toBe(false)
    expect(saved.suspendedAt).toBeNull()
    expect(saved.suspendedReason).toBeNull()
    expect(sessionRepository.findAllByUserUuid).not.toHaveBeenCalled()
    expect(sessionRepository.remove).not.toHaveBeenCalled()
    expect(ephemeralSessionRepository.deleteOne).not.toHaveBeenCalled()
    expect(revokedSessionRepository.remove).not.toHaveBeenCalled()
  })
})
