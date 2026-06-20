import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { TrustedDevice } from '../../TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateTrustedDeviceDTO } from './CreateTrustedDeviceDTO'
import { CreateTrustedDeviceResult } from './CreateTrustedDeviceResult'

/**
 * Standard Red Notes: marks the current device as trusted so that future
 * sign-ins from it may skip the interactive second factor (TOTP/U2F/magic-link).
 *
 * SECURITY:
 *  - A trusted device only EVER bypasses the second factor. The account
 *    password is always required (it is checked in SignIn after the 2FA gate),
 *    and the end-to-end encryption key is still derived client-side from the
 *    real account password. Trust never grants decryption.
 *  - The endpoint that issues this is authenticated (cross-service token), so it
 *    can only be reached after a full, already-2FA'd sign-in.
 *  - The token is high-entropy (256 bits) and stored only as a bcrypt hash.
 *  - The trust hard-expires after `trustDurationDays`; revoking the row (or all
 *    rows) invalidates it immediately.
 */
export class CreateTrustedDevice implements UseCaseInterface<CreateTrustedDeviceResult> {
  private readonly TRUSTED_DEVICE_TOKEN_BYTE_LENGTH = 32

  constructor(
    private trustedDeviceRepository: TrustedDeviceRepositoryInterface,
    private userRepository: UserRepositoryInterface,
    private trustDurationDays: number,
  ) {}

  async execute(dto: CreateTrustedDeviceDTO): Promise<Result<CreateTrustedDeviceResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create trusted device: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not create trusted device: user not found.')
    }

    const label = (dto.label ?? '').trim()
    if (label.length === 0) {
      return Result.fail('Could not create trusted device: a label is required.')
    }

    // High-entropy, server-generated token. Stored only as a bcrypt hash; the
    // plaintext is returned to the caller exactly once below.
    const plaintextToken = crypto.randomBytes(this.TRUSTED_DEVICE_TOKEN_BYTE_LENGTH).toString('base64url')

    const hashedToken = await bcrypt.hash(plaintextToken, User.PASSWORD_HASH_COST)

    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + this.trustDurationDays * 24 * 60 * 60 * 1000)

    const trustedDeviceOrError = TrustedDevice.create({
      userUuid: userUuid.value,
      hashedToken,
      label: label.slice(0, 255),
      createdAt,
      lastUsedAt: null,
      expiresAt,
    })
    if (trustedDeviceOrError.isFailed()) {
      return Result.fail(`Could not create trusted device: ${trustedDeviceOrError.getError()}`)
    }
    const trustedDevice = trustedDeviceOrError.getValue()

    await this.trustedDeviceRepository.save(trustedDevice)

    return Result.ok({
      uuid: trustedDevice.id.toString(),
      label: trustedDevice.props.label,
      token: plaintextToken,
      createdAt: createdAt.getTime(),
      expiresAt: expiresAt.getTime(),
    })
  }
}
