import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'

import { ListTrustedDevicesDTO } from './ListTrustedDevicesDTO'

export class ListTrustedDevices implements UseCaseInterface<TrustedDevice[]> {
  constructor(private trustedDeviceRepository: TrustedDeviceRepositoryInterface) {}

  async execute(dto: ListTrustedDevicesDTO): Promise<Result<TrustedDevice[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list trusted devices: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const trustedDevices = await this.trustedDeviceRepository.findByUserUuid(userUuid)

    return Result.ok(trustedDevices)
  }
}
