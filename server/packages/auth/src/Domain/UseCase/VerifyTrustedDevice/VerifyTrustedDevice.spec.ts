import * as bcrypt from 'bcryptjs'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { VerifyTrustedDevice } from './VerifyTrustedDevice'

describe('VerifyTrustedDevice', () => {
  let trustedDeviceRepository: TrustedDeviceRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const email = 'user@example.com'
  const plaintextToken = 'super-secret-device-token'
  let hashedToken: string

  const makeDevice = (overrides: Partial<Parameters<typeof TrustedDevice.create>[0]> = {}): TrustedDevice => {
    const now = Date.now()
    return TrustedDevice.create({
      userUuid,
      hashedToken,
      label: 'Chrome on macOS',
      createdAt: new Date(now - 1000),
      lastUsedAt: null,
      expiresAt: new Date(now + 30 * 86_400_000),
      ...overrides,
    }).getValue()
  }

  const createUseCase = () => new VerifyTrustedDevice(trustedDeviceRepository, userRepository)

  beforeAll(async () => {
    hashedToken = await bcrypt.hash(plaintextToken, 11)
  })

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    trustedDeviceRepository = {} as jest.Mocked<TrustedDeviceRepositoryInterface>
    trustedDeviceRepository.findByUserUuid = jest.fn().mockResolvedValue([makeDevice()])
    trustedDeviceRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should return true (bypass second factor) for a valid, non-expired token', async () => {
    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
  })

  it('should update last-used time on a successful match', async () => {
    await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(trustedDeviceRepository.save).toHaveBeenCalledTimes(1)
  })

  it('should not let a last-used bookkeeping failure block the bypass', async () => {
    trustedDeviceRepository.save = jest.fn().mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
  })

  it('should return false when no token is presented', async () => {
    const result = await createUseCase().execute({ email, deviceToken: '' })

    expect(result.getValue()).toBe(false)
  })

  it('should return false when the token does not match', async () => {
    const result = await createUseCase().execute({ email, deviceToken: 'wrong-token' })

    expect(result.getValue()).toBe(false)
    expect(trustedDeviceRepository.save).not.toHaveBeenCalled()
  })

  it('should return false (no bypass) for an expired device even if the token matches', async () => {
    const now = Date.now()
    trustedDeviceRepository.findByUserUuid = jest.fn().mockResolvedValue([
      makeDevice({
        createdAt: new Date(now - 40 * 86_400_000),
        expiresAt: new Date(now - 1000),
      }),
    ])

    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.getValue()).toBe(false)
    expect(trustedDeviceRepository.save).not.toHaveBeenCalled()
  })

  it('should return false (no bypass) after revocation removed the device (empty list)', async () => {
    trustedDeviceRepository.findByUserUuid = jest.fn().mockResolvedValue([])

    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.getValue()).toBe(false)
  })

  it('should return false when the user is not found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.getValue()).toBe(false)
  })

  it('should match the correct device among several, skipping an expired one', async () => {
    const now = Date.now()
    const otherHash = await bcrypt.hash('other-token', 11)
    trustedDeviceRepository.findByUserUuid = jest.fn().mockResolvedValue([
      makeDevice({
        hashedToken: otherHash,
        createdAt: new Date(now - 40 * 86_400_000),
        expiresAt: new Date(now - 1000),
      }),
      makeDevice(),
    ])

    const result = await createUseCase().execute({ email, deviceToken: plaintextToken })

    expect(result.getValue()).toBe(true)
  })
})
