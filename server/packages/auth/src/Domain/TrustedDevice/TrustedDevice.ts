import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { TrustedDeviceProps } from './TrustedDeviceProps'

export class TrustedDevice extends Entity<TrustedDeviceProps> {
  private constructor(props: TrustedDeviceProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: TrustedDeviceProps, id?: UniqueEntityId): Result<TrustedDevice> {
    if (props.userUuid.length === 0) {
      return Result.fail<TrustedDevice>('Trusted device user uuid cannot be empty')
    }

    if (props.hashedToken.length === 0) {
      return Result.fail<TrustedDevice>('Trusted device token hash cannot be empty')
    }

    if (props.label.length === 0) {
      return Result.fail<TrustedDevice>('Trusted device label cannot be empty')
    }

    if (props.label.length > 255) {
      return Result.fail<TrustedDevice>('Trusted device label cannot be longer than 255 characters')
    }

    if (props.expiresAt.getTime() <= props.createdAt.getTime()) {
      return Result.fail<TrustedDevice>('Trusted device expiry must be after its creation time')
    }

    return Result.ok<TrustedDevice>(new TrustedDevice(props, id))
  }

  /**
   * True when the trust window has elapsed. A trusted device that is expired
   * MUST NOT bypass the second factor; the caller falls through to the normal
   * interactive MFA enforcement.
   */
  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime()
  }
}
