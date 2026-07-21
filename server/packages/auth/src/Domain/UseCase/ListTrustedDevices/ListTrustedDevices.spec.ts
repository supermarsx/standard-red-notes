import { Uuid } from '@standardnotes/domain-core'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'

import { ListTrustedDevices } from './ListTrustedDevices'

describe('ListTrustedDevices', () => {
  let trustedDeviceRepository: TrustedDeviceRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const devices = [{ props: { label: 'Laptop' } }] as jest.Mocked<TrustedDevice[]>

  const createUseCase = () => new ListTrustedDevices(trustedDeviceRepository)

  beforeEach(() => {
    trustedDeviceRepository = {} as jest.Mocked<TrustedDeviceRepositoryInterface>
    trustedDeviceRepository.findByUserUuid = jest.fn().mockResolvedValue(devices)
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list trusted devices')
    expect(trustedDeviceRepository.findByUserUuid).not.toHaveBeenCalled()
  })

  it('should return the trusted devices scoped to the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(devices)

    expect(trustedDeviceRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    const queriedUuid = (trustedDeviceRepository.findByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)
  })
})
