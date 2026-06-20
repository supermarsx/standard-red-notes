import { UniqueEntityId } from '@standardnotes/domain-core'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'

import { DeleteTrustedDevice } from './DeleteTrustedDevice'

describe('DeleteTrustedDevice', () => {
  let trustedDeviceRepository: TrustedDeviceRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const deviceId = '11111111-1111-1111-1111-111111111111'

  const createUseCase = () => new DeleteTrustedDevice(trustedDeviceRepository)

  const buildDevice = (owner = userUuid) =>
    TrustedDevice.create(
      {
        userUuid: owner,
        hashedToken: 'hashed-token',
        label: 'Chrome on macOS',
        createdAt: new Date(Date.now() - 1000),
        lastUsedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      new UniqueEntityId(deviceId),
    ).getValue()

  beforeEach(() => {
    trustedDeviceRepository = {} as jest.Mocked<TrustedDeviceRepositoryInterface>
    trustedDeviceRepository.findById = jest.fn().mockResolvedValue(buildDevice())
    trustedDeviceRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', deviceId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail (no revoke) if the device belongs to another user', async () => {
    trustedDeviceRepository.findById = jest
      .fn()
      .mockResolvedValue(buildDevice('99999999-9999-9999-9999-999999999999'))

    const result = await createUseCase().execute({ userUuid, deviceId })

    expect(result.isFailed()).toBe(true)
    expect(trustedDeviceRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail if the device does not exist', async () => {
    trustedDeviceRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, deviceId })

    expect(result.isFailed()).toBe(true)
    expect(trustedDeviceRepository.remove).not.toHaveBeenCalled()
  })

  it('should revoke (remove) an owned device immediately', async () => {
    const result = await createUseCase().execute({ userUuid, deviceId })

    expect(result.isFailed()).toBe(false)
    expect(trustedDeviceRepository.remove).toHaveBeenCalledTimes(1)
  })
})
