import * as bcrypt from 'bcryptjs'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateTrustedDevice } from './CreateTrustedDevice'

describe('CreateTrustedDevice', () => {
  let trustedDeviceRepository: TrustedDeviceRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const trustDurationDays = 30

  const validDto = {
    userUuid,
    label: 'Chrome on macOS',
  }

  const createUseCase = () => new CreateTrustedDevice(trustedDeviceRepository, userRepository, trustDurationDays)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    trustedDeviceRepository = {} as jest.Mocked<TrustedDeviceRepositoryInterface>
    trustedDeviceRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(trustedDeviceRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if a label is not provided', async () => {
    const result = await createUseCase().execute({ ...validDto, label: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(trustedDeviceRepository.save).not.toHaveBeenCalled()
  })

  it('should persist a device with an expiry of now + trust duration', async () => {
    const before = Date.now()
    const result = await createUseCase().execute(validDto)
    const after = Date.now()

    expect(result.isFailed()).toBe(false)
    const created = result.getValue()

    expect(trustedDeviceRepository.save).toHaveBeenCalledTimes(1)
    const saved = (trustedDeviceRepository.save as jest.Mock).mock.calls[0][0] as TrustedDevice

    expect(created.uuid).toEqual(saved.id.toString())
    expect(saved.props.userUuid).toEqual(userUuid)
    expect(saved.props.lastUsedAt).toBeNull()
    expect(saved.props.expiresAt.getTime()).toBeGreaterThanOrEqual(before + trustDurationDays * 86_400_000)
    expect(saved.props.expiresAt.getTime()).toBeLessThanOrEqual(after + trustDurationDays * 86_400_000)
  })

  it('should return the plaintext token exactly once and store only its hash', async () => {
    const result = await createUseCase().execute(validDto)
    const created = result.getValue()

    expect(typeof created.token).toBe('string')
    expect(created.token.length).toBeGreaterThan(0)

    const saved = (trustedDeviceRepository.save as jest.Mock).mock.calls[0][0] as TrustedDevice
    // Stored value is a bcrypt hash, never the plaintext.
    expect(saved.props.hashedToken).not.toEqual(created.token)
    await expect(bcrypt.compare(created.token, saved.props.hashedToken)).resolves.toBe(true)
  })

  it('should generate a unique token per device', async () => {
    const first = (await createUseCase().execute(validDto)).getValue()
    const second = (await createUseCase().execute(validDto)).getValue()

    expect(first.token).not.toEqual(second.token)
  })
})
