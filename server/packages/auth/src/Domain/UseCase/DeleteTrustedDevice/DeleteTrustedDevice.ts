import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'

import { DeleteTrustedDeviceDTO } from './DeleteTrustedDeviceDTO'

/**
 * Revoking a trusted device removes the row. Because the second-factor bypass
 * looks the token up in the database on every sign-in, removal takes effect
 * IMMEDIATELY: the next sign-in from that device falls through to the normal
 * interactive MFA enforcement.
 */
export class DeleteTrustedDevice implements UseCaseInterface<string> {
  constructor(private trustedDeviceRepository: TrustedDeviceRepositoryInterface) {}

  async execute(dto: DeleteTrustedDeviceDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete trusted device: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const trustedDevice = await this.trustedDeviceRepository.findById(new UniqueEntityId(dto.deviceId))
    // Ownership check: never allow revoking another user's trusted device.
    if (!trustedDevice || trustedDevice.props.userUuid !== userUuid.value) {
      return Result.fail('Trusted device not found')
    }

    await this.trustedDeviceRepository.remove(trustedDevice)

    return Result.ok('Trusted device revoked')
  }
}
